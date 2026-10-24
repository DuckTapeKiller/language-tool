import { describe, expect, test } from "bun:test";
import * as Bun from "bun";
import * as api from "../api";
import { suggestionChange } from "../helpers";
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

describe.skipIf(!available)(`Spanish varieties with ${server}`, () => {
    const text = "Vos sabés que tenés razón y no tenés que preocuparte.";
    const variety = (es: string) => ({
        preferredLanguages: ["en", "es"],
        languageVariety: { ...DEFAULT_SETTINGS.languageVariety, es },
    });

    test("generic Spanish marks voseo", async () => {
        const lints = await check(text, variety("es"));
        expect(lints.map(l => l.ruleId)).toContain("VOSEO");
    });

    test("the voseo variety accepts it", async () => {
        expect(await check(text, variety("es-AR"))).toEqual([]);
        // And still checks spelling
        const lints = await check("Vos sabés que tenés razón en el mercao.", variety("es-AR"));
        expect(lints.map(l => l.replacements[0])).toContain("mercado");
    });

    test("a note in Spanish follows the variety", async () => {
        expect(await check(text, { ...variety("es-AR"), staticLanguage: "es" })).toEqual([]);
    });
});

describe.skipIf(!available)(`Italics inside quotation marks with ${server}`, () => {
    test("the rule replaces the «» suggestion and keeps spelling inside", async () => {
        const text =
            "Roger Ekirch, profesor de historia en la Universidad Virginia Tech, en Estados Unidos y autor del libro “*At Day's Close: A History of Nighttime*” (Al final del día: una historia de la noche).";
        const options: LTOptions = {
            ...DEFAULT_SETTINGS,
            endpoint: "custom",
            serverUrl: server,
            preferredLanguages: ["en", "es"],
            otherLanguages: "ignore",
        };
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        const lints = await api.check(
            options,
            null,
            offset + annotations.optimize(),
            annotations,
            text,
        );
        const rules = lints.map(l => l.ruleId);
        expect(rules).toContain("RAE_COMILLAS_Y_CURSIVA");
        expect(rules).not.toContain("RAE_COMILLAS_ANGULARES");
        // Spelling inside the quotation is still reported
        expect(lints.some(l => text.slice(l.range.from, l.range.to) === "Close")).toBeTrue();
        const italic = lints.find(l => l.ruleId === "RAE_COMILLAS_Y_CURSIVA")!;
        expect(text.slice(italic.range.from, italic.range.to)).toBe(
            "“*At Day's Close: A History of Nighttime*”",
        );
        expect(italic.replacements).toEqual([
            "*At Day's Close: A History of Nighttime*",
            "«At Day's Close: A History of Nighttime»",
        ]);
    });

    test("quotation marks without italics still get the «» rule", async () => {
        const text = "El periodista escribió “una crisis sin precedentes” en su columna.";
        const options: LTOptions = { ...DEFAULT_SETTINGS, endpoint: "custom", serverUrl: server };
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        const lints = await api.check(
            options,
            null,
            offset + annotations.optimize(),
            annotations,
            text,
        );
        expect(lints.map(l => l.ruleId)).toContain("RAE_COMILLAS_ANGULARES");
    });
});

describe.skipIf(!available)(`Title case in Spanish headings with ${server}`, () => {
    async function headingFix(
        heading: string,
        body = "Un párrafo en español para que el texto se detecte bien.",
    ): Promise<string[]> {
        const text = `## ${heading}\n\n${body}`;
        const options: LTOptions = {
            ...DEFAULT_SETTINGS,
            endpoint: "custom",
            serverUrl: server,
            staticLanguage: "es",
        };
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        const lints = await api.check(
            options,
            null,
            offset + annotations.optimize(),
            annotations,
            text,
        );
        return lints.filter(l => l.ruleId === "RAE_TITULO_MAYUSCULAS").map(l => l.replacements[0]);
    }

    test("the title is put in sentence case", async () => {
        expect(await headingFix("Historia Y Desarrollo De La Ciudad")).toEqual([
            "Historia y desarrollo de la ciudad",
        ]);
    });

    test("proper names keep their capital", async () => {
        // LanguageTool knows «Heredia» and «Cartagena»; the note shows «Pedro» is a name
        const body = "La vida de Pedro de Heredia fue larga y llena de viajes.";
        expect(await headingFix("La Historia De Pedro De Heredia En Cartagena", body)).toEqual([
            "La historia de Pedro de Heredia en Cartagena",
        ]);
    });

    test("names alone are not title case", async () => {
        expect(await headingFix("Gabriel García Márquez")).toEqual([]);
    });
});

describe.skipIf(!available)(`Formatting kept with ${server}`, () => {
    async function lintsFor(text: string) {
        const options: LTOptions = {
            ...DEFAULT_SETTINGS,
            endpoint: "custom",
            serverUrl: server,
            preferredLanguages: ["en", "es"],
            otherLanguages: "ignore",
            paragraphLanguages: true,
        };
        const { offset, annotations } = new SyntaxTree(text).annotate(undefined);
        const { requests } = api.planRequests(
            options,
            offset + annotations.optimize(),
            annotations,
        );
        return (
            await Promise.all(requests.map(r => api.check(options, null, r.offset, r.text, text)))
        ).flat();
    }

    test("a suggestion that would change the emphasis is withheld", async () => {
        const text =
            "_**Demandante**_: _Familia francesa_ _._\n\nOtro párrafo en español para el contexto.";
        const lint = (await lintsFor(text)).find(l =>
            text.slice(l.range.from, l.range.to).includes("_."),
        );
        expect(lint).toBeDefined();
        expect(lint!.edits?.every(e => e === null)).toBeTrue();
    });

    test("the space forgotten before bold is added outside it, first", async () => {
        const text =
            "En 2005, el director de Viral II, Alfred Prince, anunció el fin de todos los experimentos y**aseguró que la organización** **estaba haciendo arreglos para «cuidar de por vida» a los chimpancés**.";
        const lint = (await lintsFor(text)).find(
            l => text.slice(l.range.from, l.range.to) === "y**aseguró",
        )!;
        expect(lint.replacements[0]).toBe("y aseguró");
        const change = suggestionChange(lint, lint.range, 0)!;
        let out = text;
        for (const c of [...change].sort((a, b) => b.from - a.from))
            out = out.slice(0, c.from) + c.insert + out.slice(c.to);
        expect(out).toContain("experimentos y **aseguró que la organización** **estaba");
    });
});
