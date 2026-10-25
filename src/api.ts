import { endpointFromUrl, getEndpoint, LTOptions } from "./settings";
import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { JSONPath } from "jsonpath-plus";
import { AnnotatedText, TextEdit } from "./annotated";
import { emphasisRanges, formattingOf, formattingRuns } from "./markdown/parser";
import { errorMessage, isSpelling } from "./helpers";
import { foreignPhrases } from "./rules/latin";
import { sentenceCase, spanishRules } from "./rules/spanish";

/** LanguageTool Check API: https://languagetool.org/http-api/swagger-ui */

/** A typo or grammar issue detected by LanguageTool */
export interface LTMatch {
    text: string;
    title: string;
    message: string;
    replacements: string[];
    /**
     * For each replacement, the changes to make relative to the start of the match,
     * or null if they would break the formatting. Without edits the whole match is replaced.
     */
    edits?: (TextEdit[] | null)[];
    categoryId: string;
    ruleId: string;
    /// The language the text was checked in, as LanguageTool reports it: «es», «en-GB»
    language?: string;
}

export interface LTRange {
    from: number;
    to: number;
}

export interface LTLint extends LTMatch {
    range: LTRange;
}

type JsonValue = string | number | boolean | { [x: string]: JsonValue } | JsonValue[] | null;

/**
 * The language to check in. Spell checking only works with a variety (e.g. "en-GB", not "en"),
 * so base languages are mapped to the configured variety.
 */
export function resolveLanguage(options: Readonly<LTOptions>): string {
    const lang = options.staticLanguage.trim();
    if (!lang || lang.toLowerCase() === "auto") return "auto";
    return options.languageVariety[lang.toLowerCase()] ?? lang;
}

/** LanguageTool only accepts preferred languages without variety (e.g. "en", not "en-GB") */
export function baseLanguageCodes(codes: readonly string[]): string[] {
    const base = codes.map(code => code.trim().split(/[-_]/)[0].toLowerCase()).filter(Boolean);
    return [...new Set(base)];
}

/** The form parameters of a check request */
export function checkParams(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    data: string,
): Record<string, string> {
    const lang = resolveLanguage(options);
    const params: { [key: string]: string } = {
        data,
        language: lang,
        enabledOnly: "false",
        level: options.pickyMode ? "picky" : "default",
    };

    if (options.motherTongue) params.motherTongue = options.motherTongue;

    if (options.enabledCategories.length)
        params.enabledCategories = options.enabledCategories.join(",");
    // "-ise" and "-ize" are both British; Oxford spelling is a house style
    const disabledCategories = options.oxfordSpelling
        ? options.disabledCategories
        : [...options.disabledCategories, "BRE_STYLE_OXFORD_SPELLING"];
    if (disabledCategories.length) params.disabledCategories = disabledCategories.join(",");

    if (options.enabledRules.length) params.enabledRules = options.enabledRules.join(",");
    if (options.disabledRules.length) params.disabledRules = options.disabledRules.join(",");

    if (lang == "auto") {
        // A generic variety (e.g. "es") is no variant, and the server rejects it here
        const variants = Object.values(options.languageVariety).filter(v => v.includes("-"));
        if (variants.length) params.preferredVariants = variants.join(",");
        // Without hints, short snippets are often detected as unrelated languages
        const preferred = baseLanguageCodes(options.preferredLanguages);
        if (preferred.length) {
            params.preferredLanguages = preferred.join(",");
            if (options.otherLanguages === "force") params.forcePreferredLanguages = "true";
        }
    }

    const endpointType = endpointFromUrl(options.serverUrl);
    if (endpointType !== "public" && apiKey && options.username) {
        params.username = options.username;
        params.apiKey = apiKey;
    }
    return params;
}

export interface CheckRequest {
    /// Offset of the text in the note
    offset: number;
    text: AnnotatedText;
}

/**
 * Divide the text to check into requests. Long notes are checked in parts, as the servers
 * limit the size of a request. LanguageTool detects one language per request, so to mix
 * languages every paragraph can be checked separately, which is only allowed on your own server.
 */
export function planRequests(
    options: Readonly<LTOptions>,
    offset: number,
    annotated: AnnotatedText,
): { requests: CheckRequest[]; parallel: number } {
    const maxSize = getEndpoint(options.serverUrl).maxSize;
    const perParagraph =
        options.paragraphLanguages &&
        resolveLanguage(options) === "auto" &&
        endpointFromUrl(options.serverUrl) === "custom";
    const parts = perParagraph
        ? annotated.paragraphs().flatMap(p => p.split(maxSize))
        : annotated.split(maxSize);

    const requests: CheckRequest[] = [];
    for (const text of parts) {
        if (text.hasText()) requests.push({ offset, text });
        offset += text.length();
    }
    return { requests, parallel: perParagraph ? 4 : 1 };
}

/**
 * The main function of LanguageTool, checking text for spell/grammar errors.
 */
export async function check(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    offset: number,
    annotated: AnnotatedText,
    source?: string,
): Promise<LTLint[]> {
    const params = checkParams(options, apiKey, annotated.stringify());

    const res = await requestUrlChecked({
        url: `${options.serverUrl}/v2/check`,
        method: "POST",
        body: new URLSearchParams(params).toString(),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
    });

    if (res.json == null) throw new Error(`Error processing response from LanguageTool.`);

    // Text detected as a language that is not preferred, e.g. a quotation, can be left unchecked
    if (
        params.language === "auto" &&
        params.preferredLanguages &&
        options.otherLanguages === "ignore"
    ) {
        const detected = baseLanguageCodes([
            jsonPath<string>("$.language.code@string()", res.json as JsonValue),
        ]);
        if (!params.preferredLanguages.split(",").includes(detected[0])) return [];
    }

    const matches = jsonPathA<JsonValue>("$.matches[*]", res.json as JsonValue);
    const lints: LTLint[] = matches.map(match => {
        const from = jsonPath<number>("$.offset@number()", match);
        const to = from + jsonPath<number>("$.length@number()", match);
        const text = annotated.extractSlice(from, to) || "";
        // A space forgotten next to a formatting marker («y**aseguró**») is the likely
        // mistake, so the suggestion that only adds it comes first
        const suggestions = jsonPathA<string>("$.replacements[*].value@string()", match);
        const split = suggestions.filter(r => annotated.splitsAtMarkup(from, to, r));
        let replacements = [...split, ...suggestions.filter(r => !split.includes(r))];
        // A misspelling made of two words joined by markup, «la**ciudadd**»: the space goes
        // first, and suggestions that would rewrite letters across the markup do not apply
        const categoryId = jsonPath<string>("$.rule.category.id@string()", match);
        const ruleId = jsonPath<string>("$.rule.id@string()", match);
        const glued = isSpelling(categoryId, ruleId)
            ? annotated.splitAtMarkup(from, to, suggestions[0])
            : null;
        if (glued) replacements = [glued, ...split.filter(r => r !== glued)];
        return {
            range: { from: offset + from, to: offset + to },
            text,
            title: jsonPath<string>("$.shortMessage@string()", match),
            message: jsonPath<string>("$.message@string()", match),
            replacements,
            edits: replacements.map(r => annotated.safeEdits(from, to, r, source, offset)),
            categoryId,
            ruleId,
        };
    });

    const detected = jsonPath<string>("$.language.code@string()", res.json as JsonValue);
    let result = lints.map(lint => closeUnpaired(lint, source));
    if (options.spanishRules && detected.toLowerCase().startsWith("es")) {
        const all = withSpanishLints(options, offset, annotated, result, source);
        result = await keepProperNames(options, apiKey, detected, offset, annotated, all, source);
    }
    const checked = source ? withheldIfFormattingChanges(source, result) : result;
    return checked.map(lint => ({ ...lint, language: detected }));
}

/// The sign that closes each opening sign
const CLOSING: Record<string, string> = {
    '"': '"',
    "'": "'",
    "“": "”",
    "«": "»",
    "‘": "’",
    "(": ")",
    "[": "]",
};

/**
 * LanguageTool's fix for a sign that is never closed is an empty pair («""»), which only
 * doubles it. Instead, the sign is closed at the end of its line, before a final full stop
 * in Spanish («Dijo que "no vendría nunca".»), or it is removed.
 */
function closeUnpaired(lint: LTLint, source?: string): LTLint {
    if (!/_UNPAIRED_(BRACKETS|QUOTES)$/.test(lint.ruleId)) return lint;
    const { from, to } = lint.range;
    const pair = (r: string) => r.length === 2 && CLOSING[r[0]] === r[1];
    const kept = lint.replacements.flatMap((r, i) => (pair(r) ? [] : [i]));
    const replacements = kept.map(i => lint.replacements[i]);
    const edits = kept.map(i => lint.edits?.[i] ?? null);
    const sign = source?.slice(from, to) ?? "";
    const closing = CLOSING[sign];
    if (source && closing && opensQuotation(source, from, to)) {
        const lineEnd = source.indexOf("\n", to);
        // Before the block ID or comment that ends the line
        const line = source.slice(to, lineEnd < 0 ? source.length : lineEnd);
        let at = to + line.replace(/(?:\s+\^[A-Za-z0-9-]+|\s*%%[^%]*%%)+\s*$/, "").length;
        while (at > to && /\s/.test(source[at - 1])) at--;
        // Inside the bold or italics that the sign is in: «**"Texto**» → «**"Texto"**»
        const markers = /[*_=~]+$/.exec(source.slice(to, at))?.[0] ?? "";
        if (markers && !/^[*_=~]/.test(source.slice(to))) at -= markers.length;
        const stop =
            lint.ruleId.startsWith("ES_") && source[at - 1] === "." && source[at - 2] !== ".";
        if (stop) at--;
        if (at > to) {
            const tail = source.slice(Math.max(to, at - 24), at);
            const shown = "…" + tail.slice(tail.indexOf(" ") + 1) + closing + (stop ? "." : "");
            replacements.unshift(shown);
            edits.unshift([{ from: at - from, to: at - from, insert: closing }]);
        }
    }
    return { ...lint, replacements, edits };
}

/// Whether the sign opens: a straight quotation mark does when it is joined to the next word
function opensQuotation(source: string, from: number, to: number): boolean {
    if (source[from] !== '"' && source[from] !== "'") return true;
    return /\S/.test(source[to] ?? " ") && /^$|[\s([¿¡—–*_=~]/.test(source[from - 1] ?? "");
}

/// Characters of markdown and Obsidian syntax near which a change may alter the formatting
const MARKUP_NEARBY = /[*_[\]()`<>=~^\\|$!#%]/;
/// Rules whose suggestions change the formatting on purpose, adding or removing italics
const FORMATTING_RULES = new Set(["RAE_COMILLAS_Y_CURSIVA", "RAE_LATINISMO_CURSIVA"]);
/// Rules whose fix rewrites the whole phrase, so LanguageTool's matches inside it go
const SUPERSEDING = new Set(["RAE_LATINISMO_CURSIVA", "RAE_LATINISMO_FORMA", "RAE_IMPERATIVO_SE"]);

/**
 * Suggestions next to markup are tried on their paragraph first: if the markdown would
 * then be read differently, e.g. «_a_ _._» → «_a__._», the suggestion is shown but cannot
 * be applied. Rules that change formatting on purpose are left as they are.
 */
function withheldIfFormattingChanges(source: string, lints: LTLint[]): LTLint[] {
    return lints.map(lint => {
        if (FORMATTING_RULES.has(lint.ruleId) || !lint.edits) return lint;
        const { from, to } = lint.range;
        // At the start of a line, a space can make a list or a heading: «7.Por» → «7. Por»
        const lineStart = source.lastIndexOf("\n", from - 1) + 1;
        const atStart = /^[\s>]*[\d.)\-+*#]*$/.test(source.slice(lineStart, from));
        if (!atStart && !MARKUP_NEARBY.test(source.slice(Math.max(0, from - 2), to + 2)))
            return lint;
        const { start, end } = surroundings(source, from, to);
        const paragraph = source.slice(start, end);
        const before = formattingOf(paragraph);
        const at = from - start;
        const edits = lint.edits.map(edits => {
            if (!edits) return edits;
            // Runs that a removed space separated become one, rather than «**a****b**»
            const joined = joinRuns(paragraph, at, edits);
            if (joined) {
                const changed = applyEdits(paragraph, at, joined.edits);
                if (formattingOf(changed) === formattingOf(joined.reference)) return joined.edits;
            }
            return formattingOf(applyEdits(paragraph, at, edits)) === before ? edits : null;
        });
        return { ...lint, edits };
    });
}

/**
 * The paragraph around a match, whose formatting a suggestion must keep. In a table it is
 * the row, and in a very long paragraph the line of the match: a note that is one long
 * table would otherwise be read again whole for every suggestion in it.
 */
function surroundings(source: string, from: number, to: number): { start: number; end: number } {
    const startAt = source.lastIndexOf("\n\n", from);
    const endAt = source.indexOf("\n\n", to);
    const start = startAt < 0 ? 0 : startAt + 2;
    const end = endAt < 0 ? source.length : endAt;
    const lineStart = source.lastIndexOf("\n", from - 1) + 1;
    const lineEndAt = source.indexOf("\n", to);
    const lineEnd = lineEndAt < 0 ? source.length : lineEndAt;
    const row = /^[ \t]*\|/.test(source.slice(lineStart, lineEnd));
    if (!row && end - start <= 20000) return { start, end };
    // Without its indent, which alone would make the line read as code
    const indent = /^[ \t]*/.exec(source.slice(lineStart, lineEnd))![0].length;
    return { start: Math.min(from, lineStart + indent), end: lineEnd };
}

/** The text with the edits applied, which are relative to `at` */
function applyEdits(text: string, at: number, edits: readonly TextEdit[]): string {
    let changed = text;
    for (const e of [...edits].sort((a, b) => b.from - a.from))
        changed = changed.slice(0, at + e.from) + e.insert + changed.slice(at + e.to);
    return changed;
}

/**
 * A space deleted between two runs of the same formatting takes their markers with it, so
 * a word split in two is joined in one run: «**desarroll** **aron**» → «**desarrollaron**».
 * Also returns the text with only the runs joined, whose formatting the result must keep.
 * Null if no edit deletes such a space.
 */
function joinRuns(
    text: string,
    at: number,
    edits: readonly TextEdit[],
): { edits: TextEdit[]; reference: string } | null {
    const deletesSpace = (e: TextEdit) =>
        !e.insert && /^\s+$/.test(text.slice(at + e.from, at + e.to));
    if (!edits.some(deletesSpace)) return null;
    const runs = formattingRuns(text);
    const joins: { from: number; to: number }[] = [];
    const joined = edits.map(e => {
        const from = at + e.from;
        const to = at + e.to;
        if (!deletesSpace(e)) return e;
        // The closing marker before the space, and the same opening marker after it
        const marker = /([*_~])\1*$/.exec(text.slice(0, from))?.[0];
        if (!marker || !text.startsWith(marker, to) || text[to + marker.length] === marker[0])
            return e;
        if (!runs.some(r => r.to === from) || !runs.some(r => r.from === to)) return e;
        joins.push({ from: from - marker.length, to: to + marker.length });
        return { from: e.from - marker.length, to: e.to + marker.length, insert: "" };
    });
    if (!joins.length) return null;
    let reference = text;
    for (const j of joins.sort((a, b) => b.from - a.from))
        reference = reference.slice(0, j.from) + "x" + reference.slice(j.to);
    return { edits: joined, reference };
}

/**
 * Headings in title case are put in sentence case, but proper names keep their capital.
 * A word is a proper name if its lowered form is a misspelling («cartagena», «ayiti»,
 * «saint-domingue»), or if the note writes it with a capital in the middle of a sentence
 * («la vida de Pedro de Heredia»). A heading whose capitals are all proper
 * names is not title case after all, and is not reported.
 */
async function keepProperNames(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    language: string,
    offset: number,
    annotated: AnnotatedText,
    lints: LTLint[],
    source?: string,
): Promise<LTLint[]> {
    // The note without its headings, where capitals mid-sentence show proper names
    const body = source?.replace(/^#{1,6}[ \t].*$/gm, "") ?? "";
    const capitalisedInBody = (word: string) =>
        new RegExp(`[\\p{Ll}\\d,;:)»”]\\s+${word}(?![\\p{L}])`, "u").test(body);
    const result: LTLint[] = [];
    for (const lint of lints) {
        if (lint.ruleId !== "RAE_TITULO_MAYUSCULAS" || !lint.text) {
            result.push(lint);
            continue;
        }
        const original = lint.text;
        const lowered = sentenceCase(original);
        // The ranges of the lowered title that are misspelt, so written as names
        const names: { from: number; to: number }[] = [];
        try {
            const params: Record<string, string> = { text: lowered, language };
            if (endpointFromUrl(options.serverUrl) !== "public" && apiKey && options.username) {
                params.username = options.username;
                params.apiKey = apiKey;
            }
            const res = await requestUrlChecked({
                url: `${options.serverUrl}/v2/check`,
                method: "POST",
                body: new URLSearchParams(params).toString(),
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
            });
            for (const match of jsonPathA<JsonValue>("$.matches[*]", res.json as JsonValue)) {
                const at = jsonPath<number>("$.offset@number()", match);
                const length = jsonPath<number>("$.length@number()", match);
                const word = original.slice(at, at + length);
                const suggestions = jsonPathA<string>("$.replacements[*].value@string()", match);
                const category = jsonPath<string>("$.rule.category.id@string()", match);
                const rule = jsonPath<string>("$.rule.id@string()", match);
                if (isSpelling(category, rule) || suggestions.includes(word))
                    names.push({ from: at, to: at + length });
            }
        } catch (e) {
            // Without LanguageTool's answer, the plain sentence case is still offered
            console.debug("Could not check the proper names of a title", e);
        }
        const fixed = sentenceCase(
            original,
            (word, index) =>
                names.some(n => n.from <= index && index < n.to) || capitalisedInBody(word),
        );
        if (fixed === original) continue;
        const from = lint.range.from - offset;
        const to = lint.range.to - offset;
        result.push({
            ...lint,
            replacements: [fixed],
            edits: [annotated.safeEdits(from, to, fixed, source, offset)],
        });
    }
    return result;
}

/// Rules that fix quotation marks together with their spacing
const QUOTES_RULES = new Set(["RAE_COMILLAS_ANGULARES"]);
/// Categories of LanguageTool matches that a more complete RAE match may replace
const REPLACEABLE = new Set(["CASING", "TYPOGRAPHY", "PUNCTUATION"]);

/** A match of the plugin's own rules, in raw positions of the checked text */
export interface LocalMatch {
    from: number;
    to: number;
    ruleId: string;
    categoryId: string;
    title: string;
    message: string;
    replacements: string[];
    /// For each replacement, the changes relative to `from`, or null if they would touch markup
    edits: (TextEdit[] | null)[];
}

/// Closing quotation mark for each opening one
const QUOTE_PAIRS: Record<string, string> = { "“": "”", '"': '"', "«": "»" };

/// What is found in the whole note, kept for the other requests of a check of that note
let noteCache: { source: string; values: Map<string, unknown> } = { source: "", values: new Map() };

/**
 * A result for the whole note, computed once: a long note is checked in hundreds of
 * requests, and scanning the whole note for each made checking it on open slow.
 */
function perNote<T>(source: string, key: string, compute: () => T): T {
    if (noteCache.source !== source) noteCache = { source, values: new Map() };
    if (!noteCache.values.has(key)) noteCache.values.set(key, compute());
    return noteCache.values.get(key) as T;
}

/**
 * Quotations whose whole text is in italics, such as “*At Day's Close*”.
 * Quotation marks and italics are never combined; as a title of a complete work goes in
 * italics and a quotation or part of a work in quotation marks, both fixes are offered.
 * `offset` is the position of the checked text in `source`, and `isText` tells whether
 * a raw position of the checked text is text, as opposed to markup such as "*".
 */
export function italicQuotations(
    source: string,
    offset: number,
    isText: (raw: number) => boolean,
): LocalMatch[] {
    const found: LocalMatch[] = [];
    const quotations = perNote(source, "italic quotations", () => [
        ...source.matchAll(/([“"«])([*_])([^*_\n]+)\2([”"»])/g),
    ]);
    for (const m of quotations) {
        if (QUOTE_PAIRS[m[1]] !== m[4]) continue;
        const open = m.index - offset;
        const close = open + m[0].length - 1;
        // The quotation marks are text, and the "*" around the text are italics, not characters
        if (!isText(open) || !isText(close) || isText(open + 1) || isText(close - 1)) continue;
        const [, , marker, inner] = m;
        const length = close - open + 1;
        found.push({
            from: open,
            to: close + 1,
            ruleId: "RAE_COMILLAS_Y_CURSIVA",
            categoryId: "TYPOGRAPHY",
            title: "Comillas y cursiva a la vez",
            message:
                "Las comillas y la cursiva no se combinan: cada una basta. Un título de obra completa (libro, periódico, película) va en cursiva y sin comillas; una cita o una parte de una obra (capítulo, artículo, canción), entre comillas y sin cursiva.",
            replacements: [`${marker}${inner}${marker}`, `«${inner}»`],
            edits: [
                // Keep the italics: drop the quotation marks
                [
                    { from: 0, to: 1, insert: "" },
                    { from: length - 1, to: length, insert: "" },
                ],
                // Keep the quotation, as «»: drop the italics
                [
                    { from: 0, to: 2, insert: "«" },
                    { from: length - 2, to: length, insert: "»" },
                ],
            ],
        });
    }
    return found;
}

/**
 * Latin phrases and foreign expressions that are not in italics, or are written wrongly:
 * «in situ» → «*in situ*», «*status quo*» → «*statu quo*». Between quotation marks, a
 * quotation in another language needs no italics. `offset` and `isText` are as for
 * {@link italicQuotations}.
 */
export function foreignExpressions(
    source: string,
    offset: number,
    isText: (raw: number) => boolean,
): LocalMatch[] {
    const found: LocalMatch[] = [];
    let marker: string | undefined;
    for (const phrase of perNote(source, "foreign phrases", () => foreignPhrases(source))) {
        const from = phrase.from - offset;
        const to = phrase.to - offset;
        let text = true;
        for (let r = from; r < to && text; r++) text = isText(r);
        if (!text) continue;
        if (/[«“"‘]/.test(source[phrase.from - 1] ?? "") && /[»”"’]/.test(source[phrase.to] ?? ""))
            continue;
        // In a wikilink, a marker would change the link
        const before = source.slice(0, phrase.from);
        if (before.lastIndexOf("[[") > before.lastIndexOf("]]")) continue;
        const start = Math.max(0, source.lastIndexOf("\n\n", phrase.from));
        const endAt = source.indexOf("\n\n", phrase.to);
        const paragraph = source.slice(start, endAt < 0 ? source.length : endAt);
        const italic = emphasisRanges(paragraph).some(
            e => start + e.from < phrase.from && phrase.to < start + e.to,
        );
        if (italic && phrase.written === phrase.right) continue;
        // The note's own marker for italics
        marker ??= perNote(source, "italic marker", () => {
            const all = emphasisRanges(source);
            return all.filter(e => e.marker === "_").length * 2 > all.length ? "_" : "*";
        });
        const replacement = italic ? phrase.right : marker + phrase.right + marker;
        found.push({
            from,
            to,
            ruleId: italic ? "RAE_LATINISMO_FORMA" : "RAE_LATINISMO_CURSIVA",
            categoryId: italic ? "GRAMMAR" : "TYPOGRAPHY",
            title: italic ? "Forma de la locución" : "Locución latina o extranjera",
            message:
                (italic
                    ? ""
                    : "Las locuciones latinas y las expresiones de otras lenguas sin adaptar se escriben en cursiva, o entre comillas, y las latinas sin tildes, como in situ, grosso modo o curriculum vitae. ") +
                (phrase.written === phrase.right ? "" : `La forma es «${phrase.right}».`),
            replacements: [replacement],
            edits: [[{ from: 0, to: to - from, insert: replacement }]],
        });
    }
    return found;
}

/**
 * Add the matches of the RAE rules that LanguageTool lacks, for text detected as Spanish.
 * `source` is the note, which tells where the headings and the italics are.
 */
function withSpanishLints(
    options: Readonly<LTOptions>,
    offset: number,
    annotated: AnnotatedText,
    found: LTLint[],
    source?: string,
): LTLint[] {
    const { text, raw } = annotated.plainText();
    // Positions of the checked text for raw positions, to find the headings in it
    const plainAt = new Map<number, number>();
    raw.forEach((r, i) => r != null && plainAt.set(r, i));
    const headings: { from: number; to: number }[] = [];
    if (source) {
        const all = perNote(source, "headings", () => [
            ...source.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm),
        ]);
        for (const m of all) {
            const start = m.index + m[0].indexOf(m[1]) - offset;
            const from = plainAt.get(start);
            const to = plainAt.get(start + m[1].length - 1);
            if (from != null && to != null) headings.push({ from, to: to + 1 });
        }
    }

    const isText = (r: number) => plainAt.has(r);
    const local: LocalMatch[] = source
        ? [
              ...italicQuotations(source, offset, isText),
              ...foreignExpressions(source, offset, isText),
          ]
        : [];
    for (const m of spanishRules(text, { headings })) {
        // The match must start and end on text of the note, not on markup
        const from = raw[m.from];
        const last = raw[m.to - 1];
        if (from == null || last == null) continue;
        // Quotation marks around italics are handled as a whole by the rule above
        if (
            m.ruleId === "RAE_COMILLAS_ANGULARES" &&
            local.some(
                l => l.ruleId === "RAE_COMILLAS_Y_CURSIVA" && l.from < last + 1 && l.to > from,
            )
        )
            continue;
        local.push({
            ...m,
            from,
            to: last + 1,
            edits: m.replacements.map(r => annotated.safeEdits(from, last + 1, r, source, offset)),
        });
    }

    const result: LTLint[] = [];
    const replaced = new Set<LTLint>();
    for (const m of local) {
        if (options.disabledRules.includes(m.ruleId)) continue;
        if (options.disabledCategories.includes(m.categoryId)) continue;
        const range = { from: offset + m.from, to: offset + m.to };
        // Where LanguageTool reports part of the same text, LanguageTool's match is kept,
        // unless it is a casing, typography or punctuation match the rule covers completely.
        // Spelling and grammar inside, e.g. inside a quotation, are always kept.
        const overlapping = found.filter(l => l.range.from < range.to && l.range.to > range.from);
        // The spacing of quotation marks goes with them: «" El libro " es» → ««El libro» es»
        const partial = overlapping.filter(l => l.range.from < range.from || l.range.to > range.to);
        const spacing = (l: LTLint) => QUOTES_RULES.has(m.ruleId) && REPLACEABLE.has(l.categoryId);
        if (partial.some(l => !spacing(l))) continue;
        // LanguageTool already reports it, with the same fix
        const same = (l: LTLint) =>
            l.range.from === range.from &&
            l.range.to === range.to &&
            l.replacements[0] === m.replacements[0];
        if (overlapping.some(same)) continue;
        for (const l of overlapping)
            if (REPLACEABLE.has(l.categoryId) || SUPERSEDING.has(m.ruleId)) replaced.add(l);
        result.push({
            range,
            text: annotated.extractSlice(m.from, m.to) ?? "",
            title: m.title,
            message: m.message,
            replacements: m.replacements,
            edits: m.edits,
            categoryId: m.categoryId,
            ruleId: m.ruleId,
        });
    }
    return [...found.filter(l => !replaced.has(l)), ...result];
}

export interface Language {
    name: string;
    code: string;
    longCode: string;
}

export async function languages(serverUrl: string): Promise<Language[]> {
    const languages = (await requestUrl({ url: `${serverUrl}/v2/languages` }).json) as JsonValue;
    if (languages == null || !(languages instanceof Array))
        throw new Error(`Error processing response from LanguageTool.`);
    // @ts-expect-error, not typed
    return languages as Language[];
}

export async function words(
    options: Readonly<LTOptions>,
    apiKey: string | null,
): Promise<string[]> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${options.serverUrl}/v2/words`, {
                    username: options.username,
                    apiKey: apiKey,
                    limit: "1000",
                }).href,
            })
        ).json as JsonValue;
        return jsonPathA<string>("$.words[*]@string()", res);
    } catch (e) {
        throw new Error(`Requesting words failed\n${errorMessage(e)}`, { cause: e });
    }
}
export async function wordsAdd(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    word: string,
): Promise<boolean> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${options.serverUrl}/v2/words/add`, {
                    username: options.username,
                    apiKey: apiKey,
                    word,
                }).href,
                method: "POST",
            })
        ).json as JsonValue;
        return jsonPath<boolean>("$.added@boolean()", res);
    } catch (e) {
        throw new Error(`Adding words failed\n${errorMessage(e)}`, { cause: e });
    }
}
export async function wordsDel(
    options: Readonly<LTOptions>,
    apiKey: string | null,
    word: string,
): Promise<boolean> {
    if (options.username == null || apiKey == null)
        throw Error(`Syncing words is only supported for premium users`);

    try {
        const res = (
            await requestUrlChecked({
                url: sUrl(`${options.serverUrl}/v2/words/delete`, {
                    username: options.username,
                    apiKey: apiKey,
                    word,
                }).href,
                method: "POST",
            })
        ).json as JsonValue;
        return jsonPath<boolean>("$.deleted@boolean()", res);
    } catch (e) {
        throw new Error(`Deleting words failed\n${errorMessage(e)}`, { cause: e });
    }
}

export interface SynonymApi {
    name: string;
    url: string;
    query: (sentence: string, selection: { from: number; to: number }) => Promise<string[]>;
}

class SynonymEn implements SynonymApi {
    name = "English";
    url = "https://qb-grammar-en.languagetool.org/phrasal-paraphraser/subscribe";
    async query(sentence: string, selection: { from: number; to: number }): Promise<string[]> {
        const index = sentence.slice(0, selection.from).split(/\s+/).length;
        const word = sentence.slice(selection.from, selection.to);

        const request = {
            message: { indices: [index], mode: 0, phrases: [word], text: sentence },
            meta: {
                clientStatus: "string",
                product: "string",
                traceID: "string",
                userID: "string",
            },
            response_queue: "string",
        };

        try {
            const res = (
                await requestUrlChecked({
                    url: this.url,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request),
                })
            ).json as JsonValue;
            return jsonPathA<string>("$.data.suggestions[*][*]@string()", res);
        } catch (e) {
            throw new Error(`Requesting synonyms failed\n${errorMessage(e)}`, { cause: e });
        }
    }
}

class SynonymDe implements SynonymApi {
    name = "Deutsch";
    url = "https://synonyms.languagetool.org/synonyms/de";
    async query(sentence: string, selection: { from: number; to: number }): Promise<string[]> {
        const word = sentence.slice(selection.from, selection.to).trim();
        const before = sentence.slice(0, selection.from).split(/\s+/).join("+");
        const after = sentence.slice(selection.to).split(/\s+/).join("+");

        try {
            const res = (
                await requestUrlChecked({
                    url: sUrl(`${this.url}/${word}`, { before, after }).href,
                    method: "GET",
                })
            ).json as JsonValue;
            return jsonPathA<string>("$.synsets[*].terms[*].term@string()", res);
        } catch (e) {
            throw new Error(`Requesting synonyms failed\n${errorMessage(e)}`, { cause: e });
        }
    }
}

export const SYNONYMS: { [key: string]: SynonymApi } = { en: new SynonymEn(), de: new SynonymDe() };

async function requestUrlChecked(request: RequestUrlParam): Promise<RequestUrlResponse> {
    let response: RequestUrlResponse;
    try {
        response = await requestUrl({ ...request, throw: false });
    } catch (e) {
        throw new Error(
            `Request to LanguageTool failed: Please check your connection and server URL.\n${errorMessage(e)}`,
            { cause: e },
        );
    }
    if (response.status === 504 || response.status === 503)
        throw new Error(`Request to LanguageTool timed out. Please try again later.`);
    if (response.status !== 200) {
        let message = response.text;
        if (message.length > 310) message = message.substring(0, 300) + "...";
        throw new Error(`Request to LanguageTool failed ${response.status}:\n${message}`);
    }
    return response;
}

function jsonPath<T>(path: string, json: JsonValue): T {
    const res = JSONPath<T | null>({ path: path, json: json, wrap: false, eval: false });
    if (res == null) throw new Error(`Error parsing response.`);
    return res;
}
function jsonPathA<T>(path: string, json: JsonValue): T[] {
    const res = JSONPath<T[] | null>({ path: path, json: json, wrap: true, eval: false });
    if (res == null || !(res instanceof Array)) throw new Error(`Error parsing response.`);
    return res;
}

function sUrl(url: string, search: Record<string, string>): URL {
    const u = new URL(url);
    u.search = new URLSearchParams(search).toString();
    return u;
}
