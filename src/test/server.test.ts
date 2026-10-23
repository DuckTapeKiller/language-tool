import { describe, expect, test } from "bun:test";
import * as Bun from "bun";
import * as api from "../api";
import { SyntaxTree } from "../markdown/parser";
import { DEFAULT_SETTINGS, LTOptions } from "../settings";

/**
 * Checks against a running LanguageTool server, skipped when none is reachable.
 * Set LT_SERVER to use another server than http://localhost:8081.
 */
const server = (Bun.env.LT_SERVER ?? "http://localhost:8081").replace(/\/+$/, "");
const available = await Bun.fetch(`${server}/v2/languages`, { signal: AbortSignal.timeout(2000) })
    .then(res => res.ok)
    .catch(() => false);

async function check(text: string, overrides: Partial<LTOptions> = {}): Promise<api.LTLint[]> {
    const options: LTOptions = {
        ...DEFAULT_SETTINGS,
        endpoint: "custom",
        serverUrl: server,
        languageVariety: { ...DEFAULT_SETTINGS.languageVariety, en: "en-GB" },
        ...overrides,
    };
    const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
    return api.check(options, null, offset + annotations.optimize(), annotations);
}

const replacements = (lints: api.LTLint[]) => lints.flatMap(l => l.replacements.slice(0, 2));

describe.skipIf(!available)(`LanguageTool server at ${server}`, () => {
    test("preferred languages stop short text being detected as another language", async () => {
        // Detected as Slovenian without hints
        const lints = await check("Teh hous", { preferredLanguages: ["en", "es"] });
        expect(replacements(lints)).toContain("The");
        expect(replacements(lints)).toContain("house");
    });

    test("variants are accepted as preferred languages", async () => {
        const lints = await check("Teh hous", { preferredLanguages: ["en-GB", "es-ES"] });
        expect(replacements(lints)).toContain("house");
    });

    test("text clearly in another language keeps its language", async () => {
        const text = "Das ist ein ganz normaler deutscher Satz über das Wetter in Berlin.";
        expect(await check(text, { preferredLanguages: ["en", "es"] })).toEqual([]);
        const forced = await check(text, {
            preferredLanguages: ["en", "es"],
            forcePreferredLanguages: true,
        });
        expect(forced.length).toBeGreaterThan(0);
    });

    test("a base language as note language still checks spelling", async () => {
        const lints = await check("Teh hous is beautifull", { staticLanguage: "en" });
        expect(lints.map(l => l.ruleId)).toContain("MORFOLOGIK_RULE_EN_GB");
    });

    test("text checked in parts keeps the ranges of the whole note", async () => {
        const text = Array.from(
            { length: 8 },
            (_, i) => `## Part ${i}\n\nThis paragraph number ${i} has a mispelled word.`,
        ).join("\n\n");
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        let partOffset = offset + annotations.optimize();
        const parts = annotations.split(80);
        expect(parts.length).toBeGreaterThan(3);

        const options: LTOptions = {
            ...DEFAULT_SETTINGS,
            endpoint: "custom",
            serverUrl: server,
            staticLanguage: "en-GB",
        };
        const words: string[] = [];
        for (const part of parts) {
            const lints = await api.check(options, null, partOffset, part);
            words.push(...lints.map(l => text.slice(l.range.from, l.range.to)));
            partOffset += part.length();
        }
        expect(words.filter(w => w === "mispelled")).toHaveLength(8);
    });

    test("checking each paragraph lets a note mix languages", async () => {
        const text =
            "This paragraph is in English and it has a mistaek.\n\n" +
            "Este párrafo está en español y tiene un herror.";
        const options: LTOptions = {
            ...DEFAULT_SETTINGS,
            endpoint: "custom",
            serverUrl: server,
            preferredLanguages: ["en", "es"],
            paragraphLanguages: true,
        };
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        const { requests } = api.planRequests(
            options,
            offset + annotations.optimize(),
            annotations,
        );
        const lints = (
            await Promise.all(requests.map(r => api.check(options, null, r.offset, r.text)))
        ).flat();

        const found = Object.fromEntries(
            lints.map(l => [text.slice(l.range.from, l.range.to), l.replacements[0]]),
        );
        expect(found).toEqual({ mistaek: "mistake", herror: "error" });
    });

    test("ranges point at the misspelled words", async () => {
        const text = "# Title\n\nAyer fui al mercao y compre unas manzanas.";
        const lints = await check(text, { preferredLanguages: ["en", "es"] });
        const words = lints.map(l => text.slice(l.range.from, l.range.to));
        expect(words).toContain("mercao");
    });
});
