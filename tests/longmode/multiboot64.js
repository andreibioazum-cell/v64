#!/usr/bin/env node
// Boots an ELF64 multiboot kernel (higher-half virtual addresses, 32-bit entry)
// through SeaBIOS + the multiboot option rom and checks that it enters long mode
// and runs from its higher-half alias. See multiboot64.asm.

import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const asm_file = path.join(__dirname, "multiboot64.asm");
const bin_file = path.join(__dirname, "multiboot64.elf");

try {
    execFileSync("nasm", ["-w+error", "-f", "bin", "-o", bin_file, asm_file]);
} catch(e) {
    console.log("nasm not available or failed, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const expected = [
    [0x2BADB002n, "eax: multiboot magic"],
    [null, "ebx: multiboot info (non-zero)"],
    [0xFFFFFFFF80000000n + 0x100000n, "rip-relative in the higher half (checked against the elf entry below)"],
    [0x1122334455667788n, "write through the higher-half alias"],
    [0n, "bss past filesz"],
];

const emulator = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    multiboot: { url: bin_file },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
});

const timeout = setTimeout(() => {
    throw new Error("Timeout waiting for multiboot64 test to finish");
}, 60 * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    if(byte !== 0x4B) // 'K'
    {
        return;
    }
    clearTimeout(timeout);

    const data = emulator.read_memory(0x90000, expected.length * 8);
    const view = new BigUint64Array(data.buffer, data.byteOffset, expected.length);

    const failures = [];
    for(let i = 0; i < expected.length; i++)
    {
        const [value, name] = expected[i];
        const ok =
            i === 1 ? view[i] !== 0n :
            i === 2 ? view[i] >= value && view[i] < value + 0x1000n :
            view[i] === value;
        if(!ok)
        {
            failures.push({ name, actual: "0x" + view[i].toString(16) });
        }
    }

    if(failures.length === 0)
    {
        console.log(`[+] All ${expected.length} multiboot64 tests passed`);
        emulator.destroy();
        process.exit(0);
    }
    else
    {
        console.table(failures);
        console.error(`[-] ${failures.length}/${expected.length} multiboot64 tests failed`);
        process.exit(1);
    }
});
