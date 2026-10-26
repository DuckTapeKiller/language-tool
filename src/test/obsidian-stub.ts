import { mock } from "bun:test";
import * as Bun from "bun";

/**
 * The obsidian package only contains type definitions, so the runtime values
 * imported by the plugin are replaced here. Requests go to the network with Bun's fetch.
 */
class Stub {}

class Notice {
    hide() {}
}

// The plugin uses window.setTimeout, as Obsidian asks; Bun has no window
(self as unknown as { window: typeof self }).window = self;

/** The operating system, as Obsidian's Platform reports it */
const system = (() => {
    try {
        return Bun.spawnSync(["uname"]).stdout.toString().trim();
    } catch {
        return "Windows";
    }
})();

/** Only the type is used: tests subclass it with an adapter over a temporary folder */
class FileSystemAdapter {}

await mock.module("obsidian", () => ({
    FileSystemAdapter,
    Platform: { isDesktop: true, isMacOS: system === "Darwin", isWin: system === "Windows" },
    Modal: Stub,
    Notice,
    PluginSettingTab: Stub,
    SecretComponent: Stub,
    Setting: Stub,
    debounce: <T extends unknown[]>(cb: (...args: T) => void) => cb,
    requestUrl: async (request: {
        url: string;
        method?: string;
        body?: string;
        headers?: Record<string, string>;
    }) => {
        const res = await Bun.fetch(request.url, {
            method: request.method,
            body: request.body,
            headers: request.headers,
        });
        const arrayBuffer = await res.arrayBuffer();
        const text = new TextDecoder().decode(arrayBuffer);
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            // Not every response is JSON, e.g. error messages
        }
        return { status: res.status, text, json, arrayBuffer };
    },
}));
