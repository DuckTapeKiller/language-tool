#!/usr/bin/env bun
import * as Bun from "bun";

const tsc = Bun.spawnSync(["tsc", "--noEmit"], { stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) throw new Error(`Type check failed (exit code ${tsc.exitCode})`);

const pkg = (await Bun.file("package.json").json()) as { version: string };
const version = pkg.version;

const externals = [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
];

await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    minify: true,
    sourcemap: false,
    external: externals,
    naming: "main.js",
    banner: `/* Language Tool Advanced v${version} */`,
});
