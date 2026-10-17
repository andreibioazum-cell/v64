#!/usr/bin/env node
/* global __dirname */
// Opens the built single-file site (build/index.html) in headless Chrome, starts it
// with 2048 MiB of guest RAM and checks that the machine really runs:
//   - the guest RAM is addressable across its whole range (bytes are restored afterwards),
//   - SeaBIOS prints to the screen, so the guest code runs,
//   - the status shows no error.
// Needs puppeteer-core (NODE_PATH) and a Chrome binary (CHROME_PATH).
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const PAGE = path.resolve(__dirname, "../../build/index.html");
const SHOT = path.resolve(__dirname, "../../build/site-2048.png");
const MiB = 1024 * 1024;

function fail(message) {
    console.error("FAIL: " + message);
    process.exitCode = 1;
}

(async () => {
    if(!fs.existsSync(PAGE)) {
        throw new Error("missing " + PAGE + " (run make build/index.html)");
    }

    // An empty CD image: the guest has nothing to boot, but SeaBIOS still runs and prints.
    const iso = path.join(os.tmpdir(), "empty-cdrom.iso");
    fs.writeFileSync(iso, Buffer.alloc(2048 * 16));

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        const page_errors = [];
        page.on("pageerror", (err) => page_errors.push(String(err && err.message ? err.message : err)));

        await page.goto("file://" + PAGE, { waitUntil: "load" });

        const input = await page.$("#iso");
        await input.uploadFile(iso);
        await page.waitForFunction(() => !document.getElementById("start").disabled, { timeout: 30000 });

        await page.select("#ram", "2048");
        await page.click("#start");

        await page.waitForFunction(
            () => window.emulator && window.emulator.v86 && window.emulator.v86.cpu,
            { timeout: 180000 }
        );

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
        await page.waitForFunction(
            () => /SeaBIOS|iPXE|bootable|Boot/i.test(document.getElementById("screen_container").textContent),
            { timeout: 300000 }
        );
        console.log("screen text: " + (await page.$eval("#screen_container", (e) => e.textContent)).trim().slice(0, 120).replace(/\s+/g, " "));

        const status = await page.$eval("#status", (e) => e.textContent);
        console.log("status: " + status);
        if(/Ошибка/.test(status)) fail("status shows an error: " + status);
        if(!/Работает/.test(status)) fail("status does not show running: " + status);

        // Fullscreen must really engage on the screen container (the button and the emulator call).
        await page.click("#fullscreen");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const fullscreen_id = await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id);
        console.log("fullscreen element: " + fullscreen_id);
        if(fullscreen_id !== "screen_container") fail("fullscreen did not engage on #screen_container: " + fullscreen_id);

        await page.screenshot({ path: SHOT });
        console.log("screenshot: " + SHOT);

        if(page_errors.length) {
            fail("page errors: " + page_errors.join(" | "));
        }
    } finally {
        await browser.close();
    }

    if(process.exitCode) {
        console.error("site-ram: FAILED");
    } else {
        console.log("site-ram: OK (2048 MiB guest RAM runs in Chrome)");
    }
})().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
});
