import { endpointFromUrl, getEndpoint, LTOptions } from "./settings";
import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { JSONPath } from "jsonpath-plus";
import { AnnotatedText, TextEdit } from "./annotated";
import { errorMessage } from "./helpers";
import { spanishRules } from "./rules/spanish";

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
        params.preferredVariants = Object.values(options.languageVariety).join(",");
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
        const replacements = jsonPathA<string>("$.replacements[*].value@string()", match);
        return {
            range: { from: offset + from, to: offset + to },
            text: annotated.extractSlice(from, to) || "",
            title: jsonPath<string>("$.shortMessage@string()", match),
            message: jsonPath<string>("$.message@string()", match),
            replacements,
            edits: replacements.map(r => annotated.safeEdits(from, to, r)),
            categoryId: jsonPath<string>("$.rule.category.id@string()", match),
            ruleId: jsonPath<string>("$.rule.id@string()", match),
        };
    });

    const detected = jsonPath<string>("$.language.code@string()", res.json as JsonValue);
    if (options.spanishRules && detected.toLowerCase().startsWith("es"))
        return withSpanishLints(options, offset, annotated, lints, source);
    return lints;
}

/// Categories of LanguageTool matches that a more complete RAE match may replace
const REPLACEABLE = new Set(["CASING", "TYPOGRAPHY", "PUNCTUATION"]);

/**
 * Add the matches of the RAE rules that LanguageTool lacks, for text detected as Spanish.
 * `source` is the note, which tells where the headings are.
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
        for (const m of source.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
            const start = m.index + m[0].indexOf(m[1]) - offset;
            const from = plainAt.get(start);
            const to = plainAt.get(start + m[1].length - 1);
            if (from != null && to != null) headings.push({ from, to: to + 1 });
        }
    }

    const result: LTLint[] = [];
    const replaced = new Set<LTLint>();
    for (const m of spanishRules(text, { headings })) {
        if (options.disabledRules.includes(m.ruleId)) continue;
        if (options.disabledCategories.includes(m.categoryId)) continue;
        // The match must start and end on text of the note, not on markup
        const from = raw[m.from];
        const last = raw[m.to - 1];
        if (from == null || last == null) continue;
        const range = { from: offset + from, to: offset + last + 1 };
        // Where LanguageTool reports part of the same text, LanguageTool's match is kept,
        // unless it is a casing, typography or punctuation match the rule covers completely.
        // Spelling and grammar inside, e.g. inside a quotation, are always kept.
        const overlapping = found.filter(l => l.range.from < range.to && l.range.to > range.from);
        if (overlapping.some(l => l.range.from < range.from || l.range.to > range.to)) continue;
        for (const l of overlapping) if (REPLACEABLE.has(l.categoryId)) replaced.add(l);
        result.push({
            range,
            text: text.slice(m.from, m.to),
            title: m.title,
            message: m.message,
            replacements: m.replacements,
            edits: m.replacements.map(r => annotated.safeEdits(from, last + 1, r)),
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
