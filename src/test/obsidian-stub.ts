import { mock } from "bun:test";
import * as Bun from "bun";

/**
 * The obsidian package only contains type definitions, so the runtime values
 * imported by the plugin are replaced here. Requests go to the network with Bun's fetch.
 */
class Stub {}

await mock.module("obsidian", () => ({
    Modal: Stub,
    Notice: Stub,
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
        const text = await res.text();
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            // Not every response is JSON, e.g. error messages
        }
        return { status: res.status, text, json };
    },
}));
