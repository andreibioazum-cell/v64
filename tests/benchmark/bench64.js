#!/usr/bin/env node
// Runs tests/benchmark/bench64.asm in 32-bit protected mode and in 64-bit long
// mode and reports the wall time of each. Set DISABLE_JIT=1 to compare against
// the interpreter.

import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

const BENCH_COLLECT_STATS = +process.env.BENCH_COLLECT_STATS;
const { V86 } = await import(BENCH_COLLECT_STATS ? root_path + "/src/main.js" : root_path + "/build/libv86.mjs");

const asm_file = path.join(__dirname, "bench64.asm");
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["32", "64"];

function run(mode)
{
    const bin_file = path.join(__dirname, `bench${mode}.bin`);
    execFileSync("nasm", ["-w+error", "-f", "bin", ...(mode === "64" ? ["-DMODE64"] : []), "-o", bin_file, asm_file]);

    return new Promise(resolve => {
        const emulator = new V86({
            wasm_path: root_path + (BENCH_COLLECT_STATS ? "/build/v86-debug.wasm" : "/build/v86.wasm"),
            bios: { url: bin_file },
            autostart: true,
            memory_size: 64 * 1024 * 1024,
            log_level: 0,
            disable_jit: +process.env.DISABLE_JIT,
        });
        let start;
        emulator.bus.register("emulator-started", () => { start = performance.now(); });
        emulator.add_listener("serial0-output-byte", byte => {
            if(byte !== 0x4B) return;
            const elapsed = performance.now() - start;
            const checksum = emulator.read_memory(0x508, 4);
            const sum = new Uint32Array(checksum.buffer, checksum.byteOffset, 1)[0];
            const instructions = emulator.get_instruction_counter();
            console.log(`${mode}-bit: ${elapsed.toFixed(0)} ms, ${(instructions / elapsed / 1000).toFixed(1)} MIPS, checksum ${sum.toString(16)}`);
            if(BENCH_COLLECT_STATS)
            {
                const cpu = emulator.v86.cpu;
                console.log(cpu.wm.exports.profiler_stat_get ? "(stats available via print_stats)" : "");
            }
            emulator.destroy();
            resolve();
        });
    });
}

for(const mode of modes)
{
    await run(mode);
}
