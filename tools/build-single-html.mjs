#!/usr/bin/env node
// Builds one self-contained index.html:
// - libv86.js (library build) inlined as a classic script
// - v86.wasm and the SeaBIOS/VGA BIOS images embedded as base64
// - site/app.js inlined as the page logic
//
// Usage: node tools/build-single-html.mjs [output-file]
// Inputs are read from build/ and bios/ relative to the repository root.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out_file = path.resolve(root, process.argv[2] || "build/index.html");

function read(rel)
{
    const file = path.join(root, rel);
    if(!fs.existsSync(file))
    {
        console.error("missing input: " + rel);
        process.exit(1);
    }
    return fs.readFileSync(file);
}

// Inline scripts end at the first "</script" in the text, so escape it.
function inline_script(text)
{
    return text.replace(/<\/script/gi, "<\\/script");
}

const libv86 = read("build/libv86.js").toString("utf8");
const app = read("site/app.js").toString("utf8");
const template = read("site/index.html").toString("utf8");

const assets = {
    wasm: read("build/v86.wasm").toString("base64"),
    seabios: read("bios/seabios.bin").toString("base64"),
    vgabios: read("bios/vgabios.bin").toString("base64"),
};

// Function replacements: the inlined text may contain "$&"-style patterns.
const html = template
    .replace("/*@LIBV86@*/", () => inline_script(libv86))
    .replace("/*@ASSETS@*/", () => "var ASSETS = " + inline_script(JSON.stringify(assets)) + ";")
    .replace("/*@APP@*/", () => inline_script(app));

if(html.includes("/*@"))
{
    console.error("unreplaced placeholder in site/index.html");
    process.exit(1);
}

fs.mkdirSync(path.dirname(out_file), { recursive: true });
fs.writeFileSync(out_file, html);

const size_mib = (fs.statSync(out_file).size / (1024 * 1024)).toFixed(2);
console.log("wrote " + path.relative(root, out_file) + " (" + size_mib + " MiB)");
