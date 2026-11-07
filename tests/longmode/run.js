#!/usr/bin/env node
// Long mode (64-bit) smoke test: assembles longmode.asm into a BIOS image,
// boots it, and verifies the results written by the 64-bit test code.
//
// The test program enters long mode from the reset vector (16-bit real mode
// -> protected mode -> CR4.PAE -> EFER.LME -> 4-level paging -> far jump into
// a 64-bit code segment) and exercises 64-bit instructions, storing qword
// results at 0x90000 and a 'K' byte on the serial port when done.

import url from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const asm_file = path.join(__dirname, "longmode.asm");
const bin_file = path.join(__dirname, "longmode.bin");

try {
    execFileSync("nasm", ["-w+error", "-f", "bin", "-o", bin_file, asm_file]);
} catch(e) {
    console.log("nasm not available or failed, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const M = 0xFFFFFFFFFFFFFFFFn;
const expected = [
    0x1122334455667788n, // 0:  mov r64, imm64
    0x2233445566778899n, // 1:  mov r8, imm64 + add r64
    0x0000000089ABCDEFn, // 2:  32-bit write zero-extends
    0n,                  // 3:  jo taken on signed overflow
    0n,                  // 4:  js taken on negative result
    0x4142434445464700n, // 5:  sil (8-bit REX register)
    0x42n,               // 6:  r8b
    0xCAFEBABEDEADBEEFn, // 7:  RIP-relative load/store
    0x0123456789ABCDEFn, // 8:  SIB with r8 base, r9 index
    0x1234567890ABCDEFn, // 9:  push/pop r64
    0x42n,               // 10: call/ret
    0x8000000000000000n, // 11: shl by 63
    8n,                  // 12: shr by 60
    M,                   // 13: sar by 63
    0x23456789ABCDEF00n, // 14: shl by cl
    0n,                  // 15: imul 2^32 * 2^32 wraps
    1n,                  // 16: mul high qword
    0x123456789ABCDEn,   // 17: div quotient
    0xF0n,               // 18: div remainder
    0xFFFFFFFF80000001n, // 19: movsxd
    1n,                  // 20: movzx
    1n,                  // 21: movsx
    0x2222n,             // 22: xchg r64
    0xEFCDAB8967452301n, // 23: bswap r64
    0n,                  // 24: inc (ZF) + jz
    0n,                  // 25: 32-bit inc in long mode
    0n,                  // 26: lea RIP-relative vs absolute reference
    15n,                 // 27: loop with rcx
    0xAABBCCDDn,         // 28: fs base via wrmsr IA32_FS_BASE
    0x0F000F000F000F00n, // 29: and r64
    0xFF000F000F000F0Fn, // 30: or r64
    M,                   // 31: xor + not
    1n,                  // 32: neg
    1n,                  // 33: setl
    200n,                // 34: cmovl
    0xFFFFFFFF80000000n, // 35: cdqe
    M,                   // 36: cqo
    6n,                  // 37: adc
    0n,                  // 38: sbb with cf
    1n,                  // 39: syscall: rcx = rip after the syscall
    0x400n,              // 40: syscall: r11 = original rflags
    0n,                  // 41: syscall: rflags df bit masked by sfmask
    0xFEEDFACEF00DF00Dn, // 42: swapgs: gs:[0] after swapgs in the handler
    0x1234000n,          // 43: swapgs: ia32_gs_base after swapgs
    0x123456789ABCDEFn,  // 44: demand paging: value after #pf handler mapped the page
    1n,                  // 45: page fault error code: not-present
    1n,                  // 46: nx fault: I/D bit in the page fault error code
    0xAAAA2222BBBB1111n, // 47: cmpxchg16b: rax <- mem on mismatch
    0n,                  // 48: cmpxchg16b: rdx <- mem+8 on mismatch
    1n,                  // 49: cmpxchg16b: ZF set on exchange
    0x5555555555555555n, // 50: cmpxchg16b: mem <- rcx:rbx
    0xDEADn,             // 51: nx page: mov was skipped by the #PF handler
    0xDEC0DE1122334455n, // 52: movq xmm8 <-> r64
    0xDEC0FFFF2233FFFFn, // 53: movdqa/por with xmm9-11
    0xDEC0DE1122334455n, // 54: movdqu store/load low qword
    0x0000FFFF0000FFFFn, // 55: psrldq after movdqu load
    0x123456789ABCn,     // 56: cvtsi2sd/cvttsd2si with r64
    0xFFFFFFFFFFFE1DC0n, // 57: cvtsi2ss/cvttss2si with r64 (-123456)
    0xAAAA5555CCCC3333n, // 58: fxsave/fxrstor round trip with xmm14
    0x10n,               // 59: SIB lea with r12 index via REX.X
    0xFACEn,             // 60: r12 as SIB base via REX.B
    0xA5A5DEADn,         // 61: IA32_GS_BASE write/read-back
    0x1234000n,          // 62: IA32_KERNEL_GS_BASE untouched by the GS write
    0xCCCCCCCCCCCCCCCCn, // 63: rep stosq: poison baseline (64-bit memset of 16 qwords)
    0x1122334455667788n, // 64: rep stosq: last qword of the memset range
    0xCCCCCCCCCCCCCCCCn, // 65: rep stosq: first qword past the range left untouched
    1n,                  // 66: rep stosq: rdi advanced by exactly the written span
    0x123456789ABCDEFn,  // 67: freshly-mapped 4K page reads phys 0x800000 content
    0x0BADC0DEABAD1234n, // 68: cr3 reload flushes stale translation to phys 0x900000
    0x123456789ABCDEFn,  // 69: invlpg picks up the rewritten PTE
    0x3020n,             // 70: cpuid 0x80000008 address sizes (48 linear, 32 physical)
    0x71717171n,         // 71: write through a high alias of a page with jit entry points
    0x12345A78n,         // 72: mov eax, imm32 (zero-extends) + mov ah, imm8
    0x0008000000000123n, // 73: mov r64, imm64
    0xFFFFFFFFFFFFBEEFn, // 74: mov r16, imm16
    0xFFFFFFFFFFFFFF33n, // 75: mov sil, imm8 (REX)
    0xFFFFFFFFFFFFFF44n, // 76: mov r9b, imm8
    8n,                  // 77: bsf (0F BC) in jitted code
    9n,                  // 78: cmpxchg (0F B1) in jitted code
    0x30a348d26a2889an,  // 79: jl/jbe/js/jo/jb/jle after cmp/test/add/and in a hot loop
    0xb6bf6aaa379b26f0n, // 80: imul/shifts/setcc/cmovcc in a hot loop
    0x154690ceac782d0n,  // 81: rotates/shift by cl/inc cf/not/neg/movsxd/cdqe/cqo/bswap/xchg/call r
    50000n,              // 82: inc at a block start preserves cf for adc
    0x4f2ab3636643714n,  // 83: adc/sbb/bt*/cmpxchg/xadd/pushf in a hot loop
    0x200n,              // 84: sysret loads IF from r11 (it was ignored at cpl 3)
];

const emulator = new V86({
    bios: { url: bin_file },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
});

// JIT_THRESHOLD=<n>: compile code after n executed instructions instead of the default
// (a low value exercises the jit on all of the test's code)
if(process.env.JIT_THRESHOLD)
{
    emulator.bus.register("emulator-started", () => {
        emulator.v86.cpu.wm.exports["set_jit_config"](5, +process.env.JIT_THRESHOLD);
    });
}

const timeout = setTimeout(() => {
    throw new Error("Timeout waiting for longmode test to finish");
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
        if(view[i] !== expected[i])
        {
            failures.push({
                name: `test ${i}`,
                expected: "0x" + expected[i].toString(16),
                actual: "0x" + view[i].toString(16),
            });
        }
    }

    if(failures.length === 0)
    {
        console.log(`[+] All ${expected.length} longmode tests passed`);
        emulator.destroy();
        process.exit(0);
    }
    else
    {
        console.table(failures);
        console.error(`[-] ${failures.length}/${expected.length} longmode tests failed`);
        process.exit(1);
    }
});
