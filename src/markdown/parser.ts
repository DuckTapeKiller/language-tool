import type { RootContent, BlockContent, Text, Root } from "mdast";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { math } from "micromark-extension-math";
import { decodeString } from "micromark-util-decode-string";
import { mathFromMarkdown } from "mdast-util-math";

import { AnnotatedText, Attach } from "../annotated";
import { wikiLink } from "./micromark-wikilink";
import { wikiLinkFromMarkdown } from "./mdast-wikilink";
import * as api from "../api";

/// A backslash escape or a character reference such as «&nbsp;» or «&#8212;»
const ESCAPE_OR_REFERENCE =
    /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#\d{1,7}|#[xX][\dA-Fa-f]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g;

/**
 * A range of Obsidian syntax, the text it belongs to, if any (see {@link Attach}), and
 * what it reads as, if anything
 */
export interface HiddenRange {
    from: number;
    to: number;
    attach?: Attach;
    interpretAs?: string;
}

/**
 * Ranges of Obsidian syntax that is not prose and that the markdown parser does not know:
 * comments, callout markers, block IDs, tags, the "!" of embeds and the "==" of highlights.
 * Inline tokens take one neighbouring space with them, so no double space is left behind.
 * A tag in the middle of a sentence reads as a neutral word instead, so the sentence
 * still reads as one: «leí sobre #historia y #arte» is not «leí sobre y».
 * Also hidden: soft hyphens, the letter of a lettered list («b.» is no misspelling), and
 * the brackets that restore letters inside a word, so «her[i]do» reads as «herido».
 */
export function obsidianSyntax(text: string): HiddenRange[] {
    const ranges: HiddenRange[] = [];
    const inline = (from: number, to: number) => {
        if (text[to] === " " && (from === 0 || /\s/.test(text[from - 1]))) to++;
        else if (text[from - 1] === " " && (to === text.length || /\s/.test(text[to]))) from--;
        ranges.push({ from, to });
    };
    for (const m of text.matchAll(/%%[\s\S]*?%%/g)) {
        if (m[0].includes("\n")) ranges.push({ from: m.index, to: m.index + m[0].length });
        else inline(m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(/^((?:[ \t]*>)+[ \t]*)(\[![^\]\n]+\][+-]? ?)/gm))
        ranges.push({ from: m.index + m[1].length, to: m.index + m[0].length, attach: "next" });
    for (const m of text.matchAll(/ \^[A-Za-z0-9-]+(?=[ \t]*$)/gm))
        ranges.push({ from: m.index, to: m.index + m[0].length, attach: "previous" });
    for (const m of text.matchAll(/(^|\s)(#(?=[\p{L}\p{N}_/-]*[\p{L}_/-])[\p{L}\p{N}_/-]+)/gmu)) {
        const start = m.index + m[1].length;
        const end = start + m[2].length;
        const lineEnd = text.indexOf("\n", end);
        const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start).trim();
        const after = text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim();
        const inSentence =
            before && after && !/#[\p{L}\p{N}_/-]+$/u.test(before) && !after.startsWith("#");
        if (inSentence) ranges.push({ from: start, to: end, interpretAs: "0" });
        else inline(start, end);
    }
    for (const m of text.matchAll(/!(?=\[\[)/g))
        ranges.push({ from: m.index, to: m.index + 1, attach: "next" });
    for (const m of text.matchAll(/==(?=\S)[^=\n]*?\S==/g)) {
        ranges.push({ from: m.index, to: m.index + 2, attach: "next" });
        const end = m.index + m[0].length;
        ranges.push({ from: end - 2, to: end, attach: "previous" });
    }
    // A soft hyphen, invisible, reads as nothing: «ciu\u00addad» is «ciudad»
    for (const m of text.matchAll(/\u00ad/g)) ranges.push({ from: m.index, to: m.index + 1 });
    for (const m of text.matchAll(/^((?:[ \t]*>)*[ \t]*)([A-Za-z][.)][ \t]+)(?=\S)/gm))
        ranges.push({ from: m.index + m[1].length, to: m.index + m[0].length });
    // Glued to a letter, and not a link, a wikilink or a reference
    for (const m of text.matchAll(/\[\p{L}+\]/gu)) {
        const end = m.index + m[0].length;
        const before = text[m.index - 1] ?? "";
        const after = text[end] ?? "";
        if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) continue;
        if (/[[!]/.test(before) || /[\]([:]/.test(after)) continue;
        ranges.push({ from: m.index, to: m.index + 1 }, { from: end - 1, to: end });
    }
    return ranges.sort((a, b) => a.from - b.from);
}

/**
 * Replace the characters in the ranges with letters, keeping line breaks and positions.
 * Letters cannot change the structure, unlike spaces (four at the start of a line make code).
 */
function mask(text: string, ranges: HiddenRange[]): string {
    if (!ranges.length) return text;
    // UTF-16 code units, as the ranges use
    const out = text.split("");
    for (const { from, to } of ranges)
        for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = "x";
    return out.join("");
}

/** Markdown as the plugin parses it, with the markers Obsidian adds */
function parseMarkdown(text: string): Root {
    return fromMarkdown(text, {
        extensions: [gfm(), frontmatter(["yaml"]), math(), wikiLink({ aliasDivider: "|" })],
        mdastExtensions: [
            gfmFromMarkdown(),
            frontmatterFromMarkdown(["yaml"]),
            mathFromMarkdown(),
            wikiLinkFromMarkdown(),
        ],
    });
}

/**
 * The formatting of markdown: its elements in order (emphasis, links, footnotes…) and
 * Obsidian's own markers. A change that keeps it has not broken any formatting.
 */
export function formattingOf(text: string): string {
    const types: string[] = [];
    const walk = (node: { type: string; children?: unknown[] }) => {
        if (!["root", "paragraph", "text"].includes(node.type)) types.push(node.type);
        for (const child of node.children ?? []) walk(child as typeof node);
    };
    walk(parseMarkdown(mask(text, obsidianSyntax(text))));
    const markers = obsidianSyntax(text).map(r => text.slice(r.from, r.to).trim());
    // Escapes and references too: removing the space of «( \ )» makes «\)», which hides
    // the backslash
    const escapes = [...text.matchAll(ESCAPE_OR_REFERENCE)].filter(
        m => decodeString(m[0]) !== m[0],
    ).length;
    return JSON.stringify([types, markers, escapes]);
}

/** The ranges of the markdown elements of these types, with their markers */
function elementRanges(text: string, types: readonly string[]): { from: number; to: number }[] {
    const ranges: { from: number; to: number }[] = [];
    const walk = (node: RootContent | Root) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (types.includes(node.type) && start != null && end != null)
            ranges.push({ from: start, to: end });
        if ("children" in node) for (const child of node.children) walk(child);
    };
    walk(parseMarkdown(mask(text, obsidianSyntax(text))));
    return ranges;
}

/** The ranges of italics in markdown, with their markers, and the marker of each */
export function emphasisRanges(text: string): { from: number; to: number; marker: string }[] {
    return elementRanges(text, ["emphasis"]).map(r => ({ ...r, marker: text[r.from] }));
}

/** The ranges of bold, italics and strikethrough in markdown, with their markers */
export function formattingRuns(text: string): { from: number; to: number }[] {
    return elementRanges(text, ["strong", "emphasis", "delete"]);
}

export class SyntaxTree {
    #raw: string;
    #tree: Root;
    #hidden: HiddenRange[];

    constructor(text: string) {
        this.#hidden = obsidianSyntax(text);
        text = mask(text, this.#hidden);
        this.#raw = text;
        this.#tree = parseMarkdown(text);
    }

    annotate(range?: api.LTRange): { offset: number; annotations: AnnotatedText } {
        const annotator = new AnnotationVisitor(this.#raw, range);
        try {
            this.#tree.children.forEach(child => annotator.visitRoot(child));
        } catch (e) {
            console.error(
                "Error while parsing markdown:\n",
                JSON.stringify(this.#tree, undefined, "  "),
            );
            throw e;
        }
        const offset = annotator.output_start ?? 0;
        // The masked Obsidian syntax is markup, so suggestions never change it
        annotator.output.hide(this.#hidden, offset);
        return { offset, annotations: annotator.output };
    }

    isInside(cursor: number, nodeType: string): boolean {
        function visit(child: RootContent): boolean {
            const startOffset = child?.position?.start.offset;
            const endOffset = child?.position?.end.offset;
            // Nodes without a position are skipped while annotating too
            if (startOffset == null || endOffset == null) return false;
            if (startOffset <= cursor && cursor < endOffset) {
                if (child.type === nodeType) {
                    return true;
                }
                if ("children" in child) return child.children.some(c => visit(c));
            }
            return false;
        }
        return this.#tree.children.some(child => visit(child));
    }
}

class AnnotationVisitor {
    raw: string;
    output: AnnotatedText;
    output_start?: number;
    output_end?: number;
    offset: number;
    range?: api.LTRange;

    constructor(raw: string, range?: api.LTRange) {
        this.raw = raw;
        this.output = new AnnotatedText();
        this.offset = 0;
        this.range = range;
    }

    /** Whether the raw text between the offsets is not glued to a word on either side */
    standsAlone(start: number, end: number): boolean {
        const word = /[\p{L}\p{N}]/u;
        return !word.test(this.raw[start - 1] ?? "") && !word.test(this.raw[end] ?? "");
    }

    visitText(node: Text) {
        const startOffset = node?.position?.start.offset;
        const endOffset = node?.position?.end.offset;
        if (startOffset == null || endOffset == null) {
            throw Error("Markdown parsing: unknown position for text node");
        }

        const raw = this.raw.slice(startOffset, endOffset);
        addLines(raw, node.value, this.output);

        if (this.output.length() !== endOffset - (this.output_start || 0)) {
            console.error(
                "Invalid output length",
                this.output.length(),
                endOffset,
                JSON.stringify(node, undefined, "  "),
            );
            throw Error("Markdown parsing: invalid output length");
        }
        this.offset = endOffset;
    }

    visitRoot(node: RootContent) {
        const startOffset = node?.position?.start.offset;
        const endOffset = node?.position?.end.offset;
        // Some transforms create nodes without a position, e.g. GFM's email autolinks inside
        // a malformed link. Their text cannot be located, so it is left out (padded as markup).
        if (startOffset == null || endOffset == null) return;

        // Skip blocks outside of the range
        if (this.range && isBlock(node)) {
            // Skip blocks before the range
            if (endOffset <= this.range.from - 1) return;
            // Skip blocks after the range
            if (startOffset >= this.range.to + 1) return;

            // Block containing start
            if (startOffset <= this.range.from && this.range.from <= endOffset) {
                this.output = new AnnotatedText();
                this.offset = startOffset;
                this.output_start = this.offset;
                console.debug("Start from", this.output_start);
            }

            // Block containing end
            if (startOffset <= this.range.to && this.range.to <= endOffset) {
                this.output_end = endOffset;
                console.debug("End at", this.output_end);
            }
        }

        // Padding before the node: markup that opens it, such as "**" or "["
        if (this.offset < startOffset) {
            this.output.pushMarkup(" ".repeat(startOffset - this.offset), undefined, "next");
            this.offset = startOffset;
        }

        switch (node.type) {
            case "text":
                this.visitText(node);
                break;
            case "inlineMath":
                // A neutral word, so the sentence around the formula still reads as one
                this.output.pushMarkup(
                    emptyMarkup(startOffset, endOffset),
                    this.standsAlone(startOffset, endOffset) ? "0" : "",
                );
                this.offset = endOffset;
                break;
            case "html":
                // A line break reads as one: «ciudad<br>de» is two words
                if (/^<br\s*\/?>$/i.test(node.value)) {
                    this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n");
                    this.offset = endOffset;
                }
                break;
            case "yaml":
            case "code":
            case "math":
            case "image":
            case "imageReference":
            case "footnoteReference":
            case "definition":
                break;
            case "strong":
            case "emphasis":
            case "delete":
            case "footnoteDefinition":
            case "linkReference":
                node.children.forEach(child => this.visitRoot(child));
                break;
            case "list":
            case "heading":
                node.children.forEach(child => this.visitRoot(child));
                this.output.pushMarkup("", "\n\n");
                break;
            case "inlineCode":
                // A neutral word: code is not prose, but the sentence around it still reads as one
                this.output.pushMarkup(
                    emptyMarkup(startOffset, endOffset),
                    this.standsAlone(startOffset, endOffset) ? "0" : "",
                );
                this.offset = endOffset;
                break;
            case "break":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n");
                this.offset = endOffset;
                break;
            case "blockquote":
            case "paragraph":
                if (node.children.length > 0) {
                    node.children.forEach(child => this.visitRoot(child));
                    this.output.pushMarkup("", "\n\n");
                }
                break;
            case "listItem":
                if (node.children.length > 0) {
                    this.output.pushMarkup("", "• ");
                    node.children.forEach(child => this.visitRoot(child));
                }
                break;
            case "link":
            case "wikiLink":
                if (node.children) {
                    node.children.forEach(child => this.visitRoot(child));
                } else {
                    this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "DUMMY");
                    this.offset = endOffset;
                }
                break;
            case "table":
                this.output.pushMarkup("", "\n");
                node.children.forEach(child => this.visitRoot(child));
                break;
            case "tableRow":
                node.children.forEach(child => this.visitRoot(child));
                this.output.pushMarkup("", "\n\n");
                break;
            case "tableCell":
                node.children.forEach(child => this.visitRoot(child));
                // Each cell reads as a paragraph of its own, so no sentence runs into the
                // next cell («Sinónimo | Palabra» is not «Sinónima palabra»), while the row
                // is still checked in one request: it has no "\n\n"
                this.output.pushMarkup("", "\n \n");
                break;
            case "thematicBreak":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n\n");
                this.offset = endOffset;
                break;
        }

        // Padding after the content: markup that closes the node, such as "**", "](url)" or a
        // footnote reference
        if (this.offset < endOffset) {
            this.output.pushMarkup(" ".repeat(endOffset - this.offset), undefined, "previous");
            this.offset = endOffset;
        }
    }
}

/// Adds text to the output, handling escape characters
function addText(text: string, output: AnnotatedText) {
    // mdast removes escapes and decodes character references, which are markup standing for
    // the character, so no edit can split them: «\\*», «&nbsp;»
    let offset = 0;
    for (const match of text.matchAll(ESCAPE_OR_REFERENCE)) {
        const start = match.index;
        const decoded = decodeString(match[0]);
        // An unknown reference stays as written
        if (decoded === match[0]) continue;
        output.pushText(text.slice(offset, start));
        output.pushMarkup(match[0], decoded);
        offset = start + match[0].length;
    }
    output.pushText(text.slice(offset));
}

function addLines(text: string, parsed: string, output: AnnotatedText) {
    const [first, ...reminder] = text.replace(/\n$/, "").split("\n");
    // Only the lines after the first are compared
    const premider = parsed.replace(/\n$/, "").split("\n").slice(1);

    if (reminder.length !== premider.length) {
        console.error("Invalid number of lines", reminder.length, premider.length, text, parsed);
        throw Error("Markdown parsing: invalid number of lines");
    }

    addText(first, output);

    for (let i = 0; i < reminder.length; i++) {
        const line = reminder[i];
        const pline = premider[i];

        // Escapes and character references are longer than what they stand for
        let indent = line.length - pline.length;
        for (const m of line.matchAll(ESCAPE_OR_REFERENCE))
            indent -= m[0].length - decodeString(m[0]).length;
        if (indent < 0) {
            console.error("Invalid indent", indent, line, pline);
            throw Error("Markdown parsing: invalid indent");
        }

        output.pushText("\n");
        output.pushMarkup(" ".repeat(indent));
        addText(line.substring(indent), output);
    }
    if (text.endsWith("\n")) output.pushText("\n");
}

function emptyMarkup(startOffset: number, endOffset: number): string {
    return " ".repeat(endOffset - startOffset);
}

function isBlock(node: RootContent): node is BlockContent {
    return [
        "blockquote",
        "code",
        "math",
        "heading",
        "html",
        "list",
        "paragraph",
        "table",
        "thematicBreak",
    ].includes(node.type);
}
