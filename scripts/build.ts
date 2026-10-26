#!/usr/bin/env bun
import * as Bun from "bun";

const tsc = Bun.spawnSync(["tsc", "--noEmit"], { stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) throw new Error(`Type check failed (exit code ${tsc.exitCode})`);

const pkg = (await Bun.file("package.json").json()) as { version: string };
const version = pkg.version;

/// Node's modules, which the synonym engine imports on desktop only
const nodeModules = ["child_process", "fs", "os", "path", "process"];

const externals = [
    ...nodeModules,
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
    plugins: [
        {
            // For the browser, Bun puts stand-ins in place of some of Node's modules, such as
            // "path" and "process", even when they are external. The synonym engine needs the
            // real ones on desktop, so they are left to the app.
            name: "node-modules",
            setup(build) {
                build.onResolve(
                    { filter: new RegExp(`^(node:)?(${nodeModules.join("|")})$`) },
                    args => ({ path: args.path.replace(/^node:/, ""), external: true }),
                );
            },
        },
    ],
});

// Obsidian loads plugins as CommonJS, where import("fs") cannot be resolved and only require
// reaches Node's modules. esbuild rewrites these imports by itself; Bun keeps them, so they
// are rewritten here. The plugin is desktop-only; the imports also stay behind
// Platform.isDesktop, as Obsidian's ESLint plugin requires.
const bundle = await Bun.file("main.js").text();
const imports = new RegExp(`import\\("(?:node:)?(${nodeModules.join("|")})"\\)`, "g");
const rewritten = bundle.replace(imports, 'Promise.resolve(require("$1"))');
if (/import\("(?:node:)?(child_process|fs|os|path|process)"\)/.test(rewritten))
    throw new Error("A Node import was left in main.js");
await Bun.write("main.js", rewritten);
