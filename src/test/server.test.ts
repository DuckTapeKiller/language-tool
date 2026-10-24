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
            otherLanguages: "force",
        });
        expect(forced.length).toBeGreaterThan(0);
    });

    test("text in other languages can be left unchecked", async () => {
        const french = "Selon Michel Louis, 22 % des victimes ont été agressées en plein villlage.";
        const italian = "Questo è un testo italiano con un erore di ortografia evidente.";
        expect((await check(french, { preferredLanguages: ["en", "es"] })).length).toBeGreaterThan(
            0,
        );
        for (const text of [french, italian])
            expect(
                await check(text, { preferredLanguages: ["en", "es"], otherLanguages: "ignore" }),
            ).toEqual([]);
        // Text in the preferred languages is still checked
        const spanish = await check("Ayer fui al mercao.", {
            preferredLanguages: ["en", "es"],
            otherLanguages: "ignore",
        });
        expect(spanish.map(l => l.replacements[0])).toContain("mercado");
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

describe.skipIf(!available)(`RAE rules with ${server}`, () => {
    test("spelling inside a quotation is kept with the quotation-mark rule", async () => {
        const text =
            'El autor del libro "Cartiagena de Indias: coompilación histórica" (2012) añade que el papel del fundador fue aplacar a los pobladores.';
        const lints = await check(text, { preferredLanguages: ["en", "es"], spanishRules: true });
        const rules = lints.map(l => `${l.ruleId}:${text.slice(l.range.from, l.range.to)}`);
        expect(rules).toContain("MORFOLOGIK_RULE_ES:Cartiagena");
        expect(rules).toContain("MORFOLOGIK_RULE_ES:coompilación");
        expect(rules.some(r => r.startsWith("RAE_COMILLAS_ANGULARES:"))).toBeTrue();
    });

    test("the English date replaces LanguageTool's casing of the month", async () => {
        const text = "Lo recibió el rey en Octubre 30, 2020.";
        const lints = await check(text, { preferredLanguages: ["en", "es"], spanishRules: true });
        expect(lints.map(l => l.ruleId)).toEqual(["RAE_FECHA"]);
        expect(lints[0].replacements[0]).toBe("30 de octubre de 2020");
    });
});
