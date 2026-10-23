import { describe, expect, test } from "bun:test";
import { AnnotatedText } from "../annotated";
import { baseLanguageCodes, checkParams, planRequests, resolveLanguage } from "../api";
import { cmpIgnoreCase, isSpelling, nonOverlapping } from "../helpers";
import { SyntaxTree } from "../markdown/parser";
import { applyNoteSettings } from "../noteSettings";
import { DEFAULT_SETTINGS, LTOptions } from "../settings";

function options(overrides: Partial<LTOptions> = {}): LTOptions {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("language", () => {
    test("auto detection by default", () => {
        expect(resolveLanguage(options())).toBe("auto");
        expect(resolveLanguage(options({ staticLanguage: " auto " }))).toBe("auto");
    });

    test("base languages use the configured variety, as spell checking needs one", () => {
        const opts = options({
            languageVariety: { ...DEFAULT_SETTINGS.languageVariety, en: "en-GB" },
        });
        expect(resolveLanguage({ ...opts, staticLanguage: "en" })).toBe("en-GB");
        expect(resolveLanguage({ ...opts, staticLanguage: "EN" })).toBe("en-GB");
        expect(resolveLanguage({ ...opts, staticLanguage: "en-US" })).toBe("en-US");
        expect(resolveLanguage({ ...opts, staticLanguage: "es" })).toBe("es");
    });

    test("preferred languages are reduced to base codes", () => {
        expect(baseLanguageCodes(["en-GB", " es ", "EN", "ca-ES-valencia", ""])).toEqual([
            "en",
            "es",
            "ca",
        ]);
    });
});

describe("check parameters", () => {
    test("preferred languages are sent with auto detection", () => {
        const params = checkParams(options({ preferredLanguages: ["en", "es"] }), null, "{}");
        expect(params.language).toBe("auto");
        expect(params.preferredLanguages).toBe("en,es");
        expect(params.forcePreferredLanguages).toBeUndefined();
    });

    test("strict mode is only sent with preferred languages", () => {
        const force = { forcePreferredLanguages: true };
        expect(checkParams(options(force), null, "{}").forcePreferredLanguages).toBeUndefined();
        const params = checkParams(options({ ...force, preferredLanguages: ["es"] }), null, "{}");
        expect(params.forcePreferredLanguages).toBe("true");
    });

    test("a static language ignores preferred languages", () => {
        const params = checkParams(
            options({ staticLanguage: "es", preferredLanguages: ["en"] }),
            null,
            "{}",
        );
        expect(params.language).toBe("es");
        expect(params.preferredLanguages).toBeUndefined();
        expect(params.preferredVariants).toBeUndefined();
    });

    test("credentials are never sent to the public server", () => {
        const params = checkParams(options({ username: "someone" }), "key", "{}");
        expect(params.apiKey).toBeUndefined();
        expect(params.username).toBeUndefined();
    });
});

describe("request planning", () => {
    const source = "First paragraph.\n\n```\ncode only\n```\n\nSecond paragraph.";
    function plan(overrides: Partial<LTOptions>) {
        const { offset, annotations } = new SyntaxTree(source).annotate(undefined);
        return planRequests(options(overrides), offset + annotations.optimize(), annotations);
    }

    test("one request by default", () => {
        const { requests, parallel } = plan({ paragraphLanguages: true });
        // The public server is the default, which allows few requests
        expect(requests).toHaveLength(1);
        expect(parallel).toBe(1);
    });

    test("one request per paragraph on your own server, skipping blocks without text", () => {
        const { requests, parallel } = plan({
            paragraphLanguages: true,
            endpoint: "custom",
            serverUrl: "http://localhost:8081",
        });
        expect(requests).toHaveLength(2);
        expect(parallel).toBeGreaterThan(1);
        const second = requests[1];
        const raw = second.text.annotations.map(a => ("text" in a ? a.text : a.markup)).join("");
        expect(source.slice(second.offset, second.offset + raw.length)).toBe(raw);
        expect(raw.trim()).toBe("Second paragraph.");
    });

    test("a static language needs no paragraphs", () => {
        const { requests } = plan({
            paragraphLanguages: true,
            endpoint: "custom",
            serverUrl: "http://localhost:8081",
            staticLanguage: "en-GB",
        });
        expect(requests).toHaveLength(1);
    });
});

describe("note settings", () => {
    const global = options({
        dictionary: ["Obsidian"],
        disabledRules: ["ARROWS"],
        disabledCategories: ["STYLE"],
        preferredLanguages: ["en", "es"],
    });

    test("without properties the global settings apply", () => {
        expect(applyNoteSettings(global, undefined)).toBe(global);
        expect(applyNoteSettings(global, {})).toEqual(global);
    });

    test("the note's dictionary is added to the global one", () => {
        const settings = applyNoteSettings(global, { "lt-dictionary": ["Wrenger"] });
        expect(settings.dictionary).toEqual(["Obsidian", "Wrenger"]);
    });

    test("rules and categories are added, languages replaced", () => {
        const settings = applyNoteSettings(global, {
            "lt-disabledRules": ["WHITESPACE_RULE"],
            "lt-disabledCategories": ["TYPOGRAPHY"],
            "lt-preferredLanguages": ["it", "de"],
            "lt-language": "auto",
            "lt-picky": true,
        });
        expect(settings.disabledRules).toEqual(["ARROWS", "WHITESPACE_RULE"]);
        expect(settings.disabledCategories).toEqual(["STYLE", "TYPOGRAPHY"]);
        expect(settings.preferredLanguages).toEqual(["it", "de"]);
        expect(settings.staticLanguage).toBe("auto");
        expect(settings.pickyMode).toBeTrue();
    });

    test("invalid values are ignored", () => {
        const settings = applyNoteSettings(global, {
            "lt-dictionary": "word",
            "lt-preferredLanguages": [1, 2],
            "lt-picky": "yes",
        });
        expect(settings.dictionary).toEqual(["Obsidian"]);
        expect(settings.preferredLanguages).toEqual(["en", "es"]);
        expect(settings.pickyMode).toBeFalse();
    });

    test("the global settings are not modified", () => {
        applyNoteSettings(global, { "lt-dictionary": ["Wrenger"] });
        expect(global.dictionary).toEqual(["Obsidian"]);
    });
});

describe("helpers", () => {
    test("spelling matches, old and new forms", () => {
        expect(isSpelling("TYPOS", "MORFOLOGIK_RULE_ES")).toBeTrue();
        expect(isSpelling("MISC", "HUNSPELL_SPELLING_RULE")).toBeTrue();
        expect(isSpelling("GRAMMAR", "QB_NEW_EN_ORTHOGRAPHY_ERROR_IDS_1")).toBeTrue();
        expect(isSpelling("GRAMMAR", "AGREEMENT_SENT_START")).toBeFalse();
    });

    test("overlapping changes keep the first one", () => {
        const changes = [
            { from: 4, to: 8, insert: "house" },
            { from: 0, to: 8, insert: "The house" },
            { from: 9, to: 11, insert: "is" },
            { from: 11, to: 11, insert: "," },
            { from: 11, to: 11, insert: ";" },
        ];
        expect(nonOverlapping(changes)).toEqual([
            { from: 0, to: 8, insert: "The house" },
            { from: 9, to: 11, insert: "is" },
            { from: 11, to: 11, insert: "," },
        ]);
    });

    test("sorting ignores case", () => {
        expect(["banana", "Apple", "apple", "Cherry"].sort(cmpIgnoreCase)).toEqual([
            "apple",
            "Apple",
            "banana",
            "Cherry",
        ]);
    });
});

describe("splitting long text", () => {
    function annotated(text: string): AnnotatedText {
        const { annotations } = new SyntaxTree(text).annotate(undefined);
        annotations.optimize();
        return annotations;
    }

    function joinedRaw(parts: AnnotatedText[]): string {
        return parts
            .flatMap(p => p.annotations)
            .map(a => ("text" in a ? a.text : a.markup))
            .join("");
    }

    test("short text stays in one part", () => {
        const text = annotated("A short paragraph.");
        expect(text.split(100)).toEqual([text]);
    });

    test("parts end at paragraphs and keep every character", () => {
        const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} has some words.`);
        const text = annotated(paragraphs.join("\n\n"));
        const raw = joinedRaw([text]);
        const parts = text.split(100);

        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(part.plainLength()).toBeLessThanOrEqual(100);
        expect(joinedRaw(parts)).toBe(raw);
        expect(parts.reduce((sum, p) => sum + p.length(), 0)).toBe(text.length());
        // Every part but the last ends with the paragraph break
        for (const part of parts.slice(0, -1)) {
            const last = part.annotations.at(-1)!;
            expect("markup" in last && last.interpretAs?.includes("\n")).toBeTrue();
        }
    });

    test("a paragraph that is too long is split between words", () => {
        const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
        const text = annotated(words);
        const parts = text.split(50);

        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(part.plainLength()).toBeLessThanOrEqual(50);
        expect(joinedRaw(parts)).toBe(words);
        for (const part of parts.slice(1)) {
            const first = part.annotations[0];
            expect("text" in first && first.text.startsWith(" ")).toBeTrue();
        }
    });

    test("paragraphs, headings and list items are separate", () => {
        const source = "# Heading\n\nFirst paragraph.\n\n- item one\n- item two\n\nLast paragraph.";
        const text = annotated(source);
        const paragraphs = text.paragraphs();
        const plain = paragraphs.map(p =>
            p.annotations
                .map(a => ("text" in a ? a.text : ""))
                .join("")
                .trim(),
        );
        expect(plain).toEqual([
            "Heading",
            "First paragraph.",
            "item one",
            "item two",
            "Last paragraph.",
        ]);
        expect(joinedRaw(paragraphs)).toBe(joinedRaw([text]));
    });

    test("markup does not count towards the limit", () => {
        const text = new AnnotatedText([
            { text: "Before " },
            { markup: "`".repeat(500), interpretAs: "code" },
            { text: " after." },
        ]);
        expect(text.split(30)).toEqual([text]);
    });
});
