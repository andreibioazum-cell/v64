#!/usr/bin/env node
/* global __dirname */
// Opens the built single-file site (build/index.html) in headless Chrome and checks it:
//
//   1. 2048 MiB of guest RAM: the guest RAM is addressable across its whole range
//      (bytes are restored afterwards), SeaBIOS prints to the screen, no error status.
//   2. Hard disk swap at runtime: a raw disk image uploaded through #hdd lands in the
//      IDE primary master and the machine boots the boot sector of that image.
//   3. Hard disk only: a fresh page where just #hdd is filled in starts and boots it.
//
// Needs puppeteer-core (NODE_PATH) and a Chrome binary (CHROME_PATH).
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const PAGE = path.resolve(__dirname, "../../build/index.html");
const SHOT = path.resolve(__dirname, "../../build/site-2048.png");
const HDD_SHOT = path.resolve(__dirname, "../../build/site-hdd.png");
const MiB = 1024 * 1024;

const HDD_MARKER = "V86HDDBOOT";
const HDD_SECTORS = 32 * 1024; // 16 MiB raw image / 512-byte sectors

function fail(message) {
    console.error("FAIL: " + message);
    // Also surface the reason as a GitHub annotation (::error:: is a workflow command).
    console.log("::error::" + String(message).replace(/\r?\n/g, " | ").slice(0, 1000));
    process.exitCode = 1;
}

// Writes a 16 MiB raw hard disk image whose MBR prints HDD_MARKER through the BIOS
// teletype service and then halts. It uses immediate operands only, so it works no
// matter which CS:IP the BIOS enters the boot sector with:
//
//     mov $0x0007, %bx       bb 07 00   ; page 0, light grey on black
//     mov $0x0E, %ah         b4 0e      ; teletype output
//     mov $0x56, %al         b0 56      ; 'V'
//     int $0x10              cd 10
//     ...                               ; one mov/int pair per character
//     jmp $                  eb fe
//
// The bytes below were assembled with as (objdump -D -b binary -m i8086 -M intel).
function make_hdd_image(file) {
    const mbr = Buffer.alloc(512);
    Buffer.from(
        "bb0700b40eb056cd10b038cd10b036cd" +
        "10b048cd10b044cd10b044cd10b042cd" +
        "10b04fcd10b04fcd10b054cd10ebfe",
        "hex"
    ).copy(mbr, 0);

    mbr.writeUInt8(0x80, 0x1BE);              // bootable partition
    mbr.writeUInt8(0x01, 0x1C0);              // start CHS sector 1
    mbr.writeUInt8(0x0C, 0x1C2);              // type: FAT32 LBA
    mbr.writeUInt8(0x0F, 0x1C3);              // end CHS head 15
    mbr.writeUInt8(0x3F, 0x1C4);              // end CHS sector 63
    mbr.writeUInt8(0x20, 0x1C5);              // end CHS cylinder 32
    mbr.writeUInt32LE(63, 0x1C6);             // start LBA
    mbr.writeUInt32LE(HDD_SECTORS - 63, 0x1CA); // partition sectors
    mbr.writeUInt16LE(0xAA55, 0x1FE);         // boot signature

    const image = Buffer.alloc(HDD_SECTORS * 512);
    mbr.copy(image, 0);
    fs.writeFileSync(file, image);
}

// Reports page errors under a prefix and returns the array to check at the end.
function collect_errors(page, errors, label) {
    page.on("pageerror", (err) => errors.push(label + ": " + String(err && err.message ? err.message : err)));
    return errors;
}

function screen_text(page) {
    return page.$eval("#screen_container", (e) => e.textContent);
}

function wait_for_screen(page, pattern, timeout) {
    return page.waitForFunction(
        (source) => new RegExp(source, "i").test(document.getElementById("screen_container").textContent),
        { timeout },
        pattern
    );
}

// The V86 constructor returns before the wasm machine exists, so the CPU, its memory
// and the device model have to be waited for before they are inspected.
async function wait_for_machine(page, timeout) {
    await page.waitForFunction(
        () => {
            const cpu = window.emulator && window.emulator.v86 && window.emulator.v86.cpu;
            return !!cpu && !!cpu.memory_size && cpu.memory_size[0] > 0 &&
                !!cpu.devices && !!cpu.devices.ide && !!cpu.devices.ide.primary;
        },
        { timeout }
    );
}

async function wait_for_start(page, timeout) {
    await page.waitForFunction(() => !document.getElementById("start").disabled, { timeout });
}

function hdd_sectors(page) {
    return page.evaluate(() => {
        const ide = window.emulator && window.emulator.v86 && window.emulator.v86.cpu.devices.ide;
        const master = ide && ide.primary && ide.primary.master;
        return master ? master.sector_count : -1;
    });
}

// Everything needed to tell why a disk did not show up in the IDE primary master.
async function hdd_state(page) {
    const state = await page.evaluate(() => {
        const ide = window.emulator && window.emulator.v86 && window.emulator.v86.cpu.devices.ide;
        const master = ide && ide.primary && ide.primary.master;
        return {
            emulator: !!window.emulator,
            set_hda: typeof (window.emulator && window.emulator.set_hda),
            ide: !!ide,
            sector_count: master ? master.sector_count : -1,
            drive_connected: master ? !!master.drive_connected : false,
            hdd_name: document.getElementById("hdd_name").textContent,
            status: document.getElementById("status").textContent,
        };
    });
    return JSON.stringify(state);
}

async function wait_for_hdd(page, timeout) {
    await page.waitForFunction(
        (sectors) => {
            const ide = window.emulator && window.emulator.v86 && window.emulator.v86.cpu.devices.ide;
            const master = ide && ide.primary && ide.primary.master;
            return !!master && master.sector_count === sectors;
        },
        { timeout },
        HDD_SECTORS
    );
}

(async () => {
    if(!fs.existsSync(PAGE)) {
        throw new Error("missing " + PAGE + " (run make build/index.html)");
    }

    // An empty CD image: the guest has nothing to boot, but SeaBIOS still runs and prints.
    const iso = path.join(os.tmpdir(), "empty-cdrom.iso");
    fs.writeFileSync(iso, Buffer.alloc(2048 * 16));

    const hdd = path.join(os.tmpdir(), "site-hdd.img");
    make_hdd_image(hdd);

    // A qcow2 header: such an image cannot be booted, the page has to say so.
    const qcow = path.join(os.tmpdir(), "site-hdd.qcow2");
    fs.writeFileSync(qcow, Buffer.concat([Buffer.from("QFI\xFB", "binary"), Buffer.alloc(4096)]));

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
        const page_errors = [];
        const page = await browser.newPage();
        collect_errors(page, page_errors, "page1");
        await page.setViewport({ width: 1280, height: 900 });

        await page.goto("file://" + PAGE, { waitUntil: "load" });

        const input = await page.$("#iso");
        await input.uploadFile(iso);
        await wait_for_start(page, 30000);

        await page.select("#ram", "2048");
        await page.click("#start");

        await wait_for_machine(page, 180000);

        // Guest RAM size as the CPU sees it.
        const size = await page.evaluate(() => window.emulator.v86.cpu.memory_size[0]);
        console.log("guest RAM: " + size + " bytes = " + (size / MiB).toFixed(3) + " MiB");
        if(Math.abs(size - 2048 * MiB) > 128 * 1024) {
            fail("guest RAM is not ~2048 MiB: " + size);
        }

        // Write and read back a byte in several places, including the top of the RAM.
        // The old value is restored in the same evaluate, so the guest is not disturbed.
        const probes = await page.evaluate((size, MiB) => {
            const mem8 = window.emulator.v86.cpu.mem8;
            const addresses = [MiB, 0x40000000, size - 0x10000, size - 1];
            return addresses.map((addr) => {
                const old = mem8[addr];
                const value = (addr * 7 + 3) & 0xff;
                mem8[addr] = value;
                const ok = mem8[addr] === value;
                mem8[addr] = old;
                return { addr, ok };
            });
        }, size, MiB);
        for(const p of probes) {
            console.log("memory probe 0x" + p.addr.toString(16) + ": " + (p.ok ? "ok" : "FAILED"));
            if(!p.ok) fail("guest RAM not writable at 0x" + p.addr.toString(16));
        }

        // The guest must print something (SeaBIOS) to the text screen.
        await wait_for_screen(page, "SeaBIOS|iPXE|bootable|Boot", 300000);
        console.log("screen text: " + (await screen_text(page)).trim().slice(0, 120).replace(/\s+/g, " "));

        const status = await page.$eval("#status", (e) => e.textContent);
        console.log("status: " + status);
        if(/Ошибка/.test(status)) fail("status shows an error: " + status);
        if(!/Работает/.test(status)) fail("status does not show running: " + status);

        await page.screenshot({ path: SHOT });
        console.log("screenshot: " + SHOT);

        // 2. Hot-swap a hard disk into the machine that is already running, the same way
        // the ISO can be swapped. The disk has to end up in the IDE primary master with
        // the right geometry, and the reboot has to run its boot sector.
        const hdd_input = await page.$("#hdd");
        if(!hdd_input) {
            fail("#hdd input is missing from the page");
        }
        else {
            await hdd_input.uploadFile(hdd);

            let attached = true;
            try {
                await wait_for_hdd(page, 60000);
            }
            catch(err) {
                attached = false;
                fail("the image was not attached to the IDE primary master: " + (await hdd_state(page)));
            }

            if(attached) {
                console.log("hdd attached: " + (await hdd_sectors(page)) + " sectors");

                try {
                    await wait_for_screen(page, HDD_MARKER, 300000);
                    console.log("hdd boot after swap: " + (await screen_text(page)).trim().slice(0, 120).replace(/\s+/g, " "));
                }
                catch(err) {
                    fail("the machine did not boot the swapped hard disk: " + (await hdd_state(page)) +
                        " screen: " + (await screen_text(page)).trim().slice(0, 200).replace(/\s+/g, " "));
                }

                const swap_status = await page.$eval("#status", (e) => e.textContent);
                console.log("status after swap: " + swap_status);
                if(/Ошибка/.test(swap_status)) fail("status shows an error after the hdd swap: " + swap_status);

                await page.screenshot({ path: HDD_SHOT });
                console.log("screenshot: " + HDD_SHOT);
            }
        }

        // 3. A fresh page with only a hard disk selected (no ISO at all) must start and
        // boot from it, which also covers the hard-disk-first boot order.
        // The machine of the first page keeps 2048 MiB and would be throttled as a
        // background tab, so it is closed before a second machine is started.
        await page.close();
        const page2 = await browser.newPage();
        collect_errors(page2, page_errors, "page2");
        await page2.setViewport({ width: 1280, height: 900 });
        await page2.bringToFront();
        await page2.goto("file://" + PAGE, { waitUntil: "load" });

        const start_disabled = await page2.$eval("#start", (e) => e.disabled);
        if(!start_disabled) fail("#start is enabled before any image is selected");

        const hdd_input2 = await page2.$("#hdd");
        await hdd_input2.uploadFile(qcow);
        try {
            await page2.waitForFunction(
                () => /qcow/.test(document.getElementById("hdd_name").textContent),
                { timeout: 30000 }
            );
            console.log("qcow2 note: " + (await page2.$eval("#hdd_name", (e) => e.textContent)).trim());
        }
        catch(err) {
            fail("a qcow2 image is not called out on the page: " + (await hdd_state(page2)));
        }

        await hdd_input2.uploadFile(hdd);
        await wait_for_start(page2, 30000);
        await page2.click("#start");

        try {
            await wait_for_machine(page2, 180000);
            await wait_for_hdd(page2, 180000);
        }
        catch(err) {
            fail("a hard-disk-only start did not attach the disk: " + (await hdd_state(page2)));
        }
        try {
            await wait_for_screen(page2, HDD_MARKER, 300000);
            console.log("hdd-only boot: " + (await screen_text(page2)).trim().slice(0, 120).replace(/\s+/g, " "));
        }
        catch(err) {
            fail("a hard-disk-only start did not boot the disk: " + (await hdd_state(page2)) +
                " screen: " + (await screen_text(page2)).trim().slice(0, 200).replace(/\s+/g, " "));
        }

        const hdd_status = await page2.$eval("#status", (e) => e.textContent);
        console.log("status hdd only: " + hdd_status);
        if(/Ошибка/.test(hdd_status)) fail("status shows an error for a hard-disk-only start: " + hdd_status);
        if(!/Работает/.test(hdd_status)) fail("status does not show running for a hard-disk-only start: " + hdd_status);

        if(page_errors.length) {
            fail("page errors: " + page_errors.join(" | "));
        }
    } finally {
        await browser.close();
    }

    if(process.exitCode) {
        console.error("site-ram: FAILED");
    } else {
        console.log("site-ram: OK (2048 MiB guest RAM, hard disk swap and hard-disk-only boot in Chrome)");
    }
})().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
});
