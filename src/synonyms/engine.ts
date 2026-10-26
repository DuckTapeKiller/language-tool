import { DataAdapter, FileSystemAdapter, Notice, Platform, requestUrl } from "obsidian";
import { ENGINE_JAR, ENGINE_JAR_SHA256 } from "./engine-jar";
import { extractZipEntry } from "./zip";

type ChildProcess = import("child_process").ChildProcess;

/**
 * OpenThesaurus Español (LGPL 2.1), as the RLA-ES project ships it in its LibreOffice
 * dictionaries. Downloaded once, the first time Spanish synonyms are asked for.
 */
export const THESAURUS = {
    url: "https://github.com/sbosio/rla-es/releases/download/v2.9/es.oxt",
    sha256: "b08a1a0e3e044697f63a67184f591f7e2c37bbb53bbfbb4780bcbd84929d6e8c",
    file: "th_es_v2.dat",
    license: "README_th_es.txt",
};

/// Without a request for this long the engine stops, which frees its memory
const IDLE_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 60 * 1000;

/** Where Java and LanguageTool are, as set in the settings; empty means found automatically */
export interface EngineSettings {
    java: string;
    languageTool: string;
}

/**
 * The Spanish synonym engine: a small Java program that ships inside the plugin
 * (src/synonyms/engine-jar.ts, built from engine/src). It reads the Spanish dictionaries of a
 * LanguageTool installation to put every synonym in the form of the selected word, «casas» →
 * «viviendas». It starts with the first request, on desktop only, and stops when idle or
 * when the plugin unloads.
 */
export class SynonymEngine {
    private child: ChildProcess | null = null;
    private address: string | null = null;
    private starting: Promise<string> | null = null;
    private idleTimer = -1;

    constructor(
        private readonly adapter: DataAdapter,
        /// The plugin's folder, relative to the vault
        private readonly folder: string,
        private readonly settings: () => EngineSettings,
    ) {}

    /** The address of the running engine, which is started first if needed */
    async url(): Promise<string> {
        this.keepAlive();
        if (this.address && this.child && this.child.exitCode === null) return this.address;
        this.starting ??= this.start().finally(() => (this.starting = null));
        return this.starting;
    }

    /** Stop the engine; the next request starts it again */
    stop() {
        window.clearTimeout(this.idleTimer);
        this.child?.kill();
        this.child = null;
        this.address = null;
    }

    private keepAlive() {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => this.stop(), IDLE_MS);
    }

    private async start(): Promise<string> {
        if (!Platform.isDesktop)
            throw new Error(
                "Spanish synonyms run on this computer, so they need Obsidian on desktop.",
            );
        const { spawn } = await import("child_process");
        const { delimiter } = await import("path");

        const settings = this.settings();
        const java = await findJava(settings.java);
        if (!java)
            throw new Error(
                "Spanish synonyms need Java 17 or later. Install it, or set where it is in the settings of Language Tool Advanced.",
            );
        const languageTool = await findLanguageTool(settings.languageTool);
        if (!languageTool)
            throw new Error(
                "Spanish synonyms need a LanguageTool installation, which has the Spanish dictionaries. Set its folder in the settings of Language Tool Advanced.",
            );
        const files = await this.prepareFiles();

        const classPath = [
            `${languageTool}/languagetool-server.jar`,
            `${languageTool}/libs/*`,
            files.engine,
        ].join(delimiter);
        const child = spawn(
            java,
            [
                "-Xms64m",
                "-Xmx512m",
                "-cp",
                classPath,
                "local.ltsynonyms.SynonymServer",
                "--thesaurus",
                files.thesaurus,
                "--parent",
                "obsidian",
            ],
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        this.child = child;

        return new Promise<string>((resolve, reject) => {
            let output = "";
            let errors = "";
            const fail = (error: Error) => {
                window.clearTimeout(timer);
                if (this.child === child) this.stop();
                reject(error);
            };
            const timer = window.setTimeout(
                () => fail(new Error("The synonym engine did not start within a minute.")),
                START_TIMEOUT_MS,
            );
            child.stdout?.on("data", (data: unknown) => {
                output += String(data);
                const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
                if (port && !this.address && this.child === child) {
                    window.clearTimeout(timer);
                    this.address = `http://127.0.0.1:${port}`;
                    resolve(this.address);
                }
            });
            child.stderr?.on("data", (data: unknown) => (errors += String(data)));
            child.on("error", error =>
                fail(new Error(`Java could not be started: ${error.message}`)),
            );
            child.on("exit", code => {
                if (this.child !== child) return;
                if (!this.address)
                    fail(
                        new Error(
                            `The synonym engine stopped while starting (${code ?? "killed"}).\n${errors.slice(-600)}`,
                        ),
                    );
                this.child = null;
                this.address = null;
            });
        });
    }

    /**
     * The engine's files in the plugin's folder: the Java archive, written from the copy inside
     * the plugin when it is missing or outdated, and the thesaurus, downloaded once
     */
    private async prepareFiles(): Promise<{ engine: string; thesaurus: string }> {
        if (!(this.adapter instanceof FileSystemAdapter))
            throw new Error("Spanish synonyms need Obsidian on desktop.");
        const dir = `${this.folder}/synonyms`;
        if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);

        const engine = `${dir}/engine.jar`;
        const current =
            (await this.adapter.exists(engine)) &&
            (await sha256(new Uint8Array(await this.adapter.readBinary(engine)))) ===
                ENGINE_JAR_SHA256;
        if (!current) await this.adapter.writeBinary(engine, copyOf(base64ToBytes(ENGINE_JAR)));

        const thesaurus = `${dir}/${THESAURUS.file}`;
        if (!(await this.adapter.exists(thesaurus))) {
            const notice = new Notice("Downloading the Spanish thesaurus (1.5 MB)…", 0);
            try {
                const response = await requestUrl({ url: THESAURUS.url, throw: false });
                if (response.status !== 200)
                    throw new Error(`The download answered ${response.status}`);
                const archive = new Uint8Array(response.arrayBuffer);
                if ((await sha256(archive)) !== THESAURUS.sha256)
                    throw new Error("The downloaded file is not the expected one");
                for (const name of [THESAURUS.license, THESAURUS.file]) {
                    const data = await extractZipEntry(archive, name);
                    await this.adapter.writeBinary(`${dir}/${name}`, copyOf(data));
                }
            } catch (e) {
                throw new Error(
                    `The Spanish thesaurus could not be downloaded from ${THESAURUS.url}: ${(e as Error).message}`,
                    { cause: e },
                );
            } finally {
                notice.hide();
            }
        }
        return {
            engine: this.adapter.getFullPath(engine),
            thesaurus: this.adapter.getFullPath(thesaurus),
        };
    }
}

/**
 * Java 17 or later: the one set in the settings (the program or its folder), else JAVA_HOME,
 * macOS's java_home, Homebrew's OpenJDK, and finally `java` on the path
 */
export async function findJava(setting: string): Promise<string | null> {
    if (!Platform.isDesktop) return null;
    const { existsSync, readdirSync, statSync } = await import("fs");
    const { spawnSync } = await import("child_process");
    const { join } = await import("path");
    const { env } = await import("process");

    const program = Platform.isWin ? "java.exe" : "java";
    const candidates: string[] = [];
    const add = (path: string | undefined) => {
        if (!path) return;
        const isDir = existsSync(path) && statSync(path).isDirectory();
        candidates.push(isDir ? join(path, "bin", program) : path);
    };
    if (setting.trim()) {
        add(setting.trim());
    } else {
        add(env.JAVA_HOME);
        if (Platform.isMacOS) {
            const home = spawnSync("/usr/libexec/java_home", { encoding: "utf8", timeout: 5000 });
            if (home.status === 0) add(home.stdout.trim());
            for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
                if (!existsSync(base)) continue;
                const jdks = readdirSync(base).filter(n => n.startsWith("openjdk"));
                for (const name of jdks.sort().reverse()) add(join(base, name));
            }
        }
        candidates.push(program);
    }
    for (const candidate of candidates) {
        const run = spawnSync(candidate, ["-version"], { encoding: "utf8", timeout: 10000 });
        if (run.status !== 0) continue;
        // «openjdk version "21.0.12"», or «java version "1.8.0_402"» for Java 8
        const version = /version "(\d+)(?:\.(\d+))?/.exec(`${run.stderr}${run.stdout}`);
        const major = version ? Number(version[1] === "1" ? version[2] : version[1]) : 0;
        if (major >= 17) return candidate;
    }
    return null;
}

/**
 * A LanguageTool folder with its server and libraries: the one set in the settings, else the
 * newest in the usual places (/opt/languagetool, the home folder, Homebrew)
 */
export async function findLanguageTool(setting: string): Promise<string | null> {
    if (!Platform.isDesktop) return null;
    const { existsSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const usable = (dir: string) =>
        existsSync(join(dir, "languagetool-server.jar")) && existsSync(join(dir, "libs"));
    if (setting.trim()) return usable(setting.trim()) ? setting.trim() : null;

    const found: string[] = [];
    for (const base of [
        "/opt/languagetool",
        homedir(),
        "/Applications",
        "/usr/local/share",
        "/opt",
    ]) {
        if (!existsSync(base)) continue;
        for (const name of readdirSync(base)) {
            const dir = join(base, name);
            if (/^LanguageTool-\d/i.test(name) && usable(dir)) found.push(dir);
        }
    }
    found.sort((a, b) => compareVersions(b, a));
    for (const dir of [
        "/opt/homebrew/opt/languagetool/libexec",
        "/usr/local/opt/languagetool/libexec",
    ])
        if (usable(dir)) found.push(dir);
    return found[0] ?? null;
}

/** «LanguageTool-6.10» after «LanguageTool-6.9» */
function compareVersions(a: string, b: string): number {
    const parts = (path: string) =>
        (/(\d+(?:\.\d+)*)\/?$/.exec(path)?.[1] ?? "0").split(".").map(Number);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** A buffer holding exactly these bytes, for the vault adapter */
function copyOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer;
}
