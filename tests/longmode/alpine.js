#!/usr/bin/env node
// Boots a 64-bit Linux distribution (Alpine "virt" x86_64 ISO) to a root shell and runs a
// command over the serial console.
//
//   ALPINE_ISO=path/to/alpine-virt-3.19.x-x86_64.iso ./tests/longmode/alpine.js
//
// By default the kernel and initramfs are taken from the ISO's boot directory by the BIOS
// (SeaBIOS + ISOLINUX). With ALPINE_KERNEL and ALPINE_INITRD set, they're booted directly
// (with the ISO attached as cdrom, for the root filesystem) and the console is on ttyS0.
// Skipped if ALPINE_ISO isn't set. DISABLE_JIT=1 runs everything in the interpreter.

import url from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const ISO = process.env.ALPINE_ISO;
if(!ISO || !fs.existsSync(ISO))
{
    console.log("ALPINE_ISO not set or not found, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const direct = process.env.ALPINE_KERNEL && process.env.ALPINE_INITRD;
const TIMEOUT = (+process.env.TIMEOUT || 900) * 1000;

const emulator = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    cdrom: { url: ISO },
    ...(direct ? {
        bzimage: { url: process.env.ALPINE_KERNEL },
        initrd: { url: process.env.ALPINE_INITRD },
        cmdline: "modules=loop,squashfs,sd-mod,usb-storage console=ttyS0",
    } : {}),
    memory_size: 512 * 1024 * 1024,
    autostart: true,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
});

if(process.env.JIT_MAX_PAGES)
{
    emulator.bus.register("emulator-started", () => {
        emulator.v86.cpu.wm.exports["set_jit_config"](1, +process.env.JIT_MAX_PAGES);
    });
}

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(0) + "s";

const timeout = setTimeout(() => {
    console.error(`[-] Timeout after ${elapsed()}, serial output:\n` + output.slice(-2000));
    process.exit(1);
}, TIMEOUT);

let output = "";
let state = "boot";

emulator.add_listener("serial0-output-byte", function(byte)
{
    output += String.fromCharCode(byte);

    if(state === "boot" && /login: $/.test(output))
    {
        console.log(`[+] Login prompt after ${elapsed()}`);
        state = "login";
        emulator.serial0_send("root\n");
    }
    else if(state === "login" && /# $/.test(output))
    {
        state = "command";
        output = "";
        emulator.serial0_send("echo ARCH=$(uname -m) SUM=$((40+2))\n");
    }
    else if(state === "command")
    {
        const m = output.match(/ARCH=(\S+) SUM=(\d+)\r?\n/);
        if(m)
        {
            clearTimeout(timeout);
            if(m[1] === "x86_64" && m[2] === "42")
            {
                console.log(`[+] Alpine x86_64 shell works (${elapsed()})`);
                emulator.destroy();
                process.exit(0);
            }
            console.error(`[-] Unexpected output: ${m[0]}`);
            process.exit(1);
        }
    }
});
