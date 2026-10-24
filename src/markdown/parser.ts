import type { RootContent, BlockContent, Text, Root } from "mdast";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";

import { AnnotatedText } from "../annotated";
import { wikiLink } from "./micromark-wikilink";
import { wikiLinkFromMarkdown } from "./mdast-wikilink";
import * as api from "../api";

const ESCAPE = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

/**
 * Ranges of Obsidian syntax that is not prose and that the markdown parser does not know:
 * comments, callout markers, block IDs, tags, the "!" of embeds and the "==" of highlights.
 * Inline tokens take one neighbouring space with them, so no double space is left behind.
 */
export function obsidianSyntax(text: string): api.LTRange[] {
    const ranges: api.LTRange[] = [];
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
        ranges.push({ from: m.index + m[1].length, to: m.index + m[0].length });
    for (const m of text.matchAll(/ \^[A-Za-z0-9-]+(?=[ \t]*$)/gm))
        ranges.push({ from: m.index, to: m.index + m[0].length });
    for (const m of text.matchAll(/(^|\s)(#(?=[\p{L}\p{N}_/-]*[\p{L}_/-])[\p{L}\p{N}_/-]+)/gmu)) {
        const start = m.index + m[1].length;
        inline(start, start + m[2].length);
    }
    for (const m of text.matchAll(/!(?=\[\[)/g)) ranges.push({ from: m.index, to: m.index + 1 });
    for (const m of text.matchAll(/==(?=\S)[^=\n]*?\S==/g)) {
        ranges.push({ from: m.index, to: m.index + 2 });
        ranges.push({ from: m.index + m[0].length - 2, to: m.index + m[0].length });
    }
    return ranges.sort((a, b) => a.from - b.from);
}

/**
 * Replace the characters in the ranges with letters, keeping line breaks and positions.
 * Letters cannot change the structure, unlike spaces (four at the start of a line make code).
 */
function mask(text: string, ranges: api.LTRange[]): string {
    if (!ranges.length) return text;
    // UTF-16 code units, as the ranges use
    const out = text.split("");
    for (const { from, to } of ranges)
        for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = "x";
    return out.join("");
}

export class SyntaxTree {
    #raw: string;
    #tree: Root;
    #hidden: api.LTRange[];

    constructor(text: string) {
        this.#hidden = obsidianSyntax(text);
        text = mask(text, this.#hidden);
        this.#raw = text;
        this.#tree = fromMarkdown(text, {
            extensions: [gfm(), frontmatter(["yaml"]), math(), wikiLink({ aliasDivider: "|" })],
            mdastExtensions: [
                gfmFromMarkdown(),
                frontmatterFromMarkdown(["yaml"]),
                mathFromMarkdown(),
                wikiLinkFromMarkdown(),
            ],
        });
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

        // Padding
        if (this.offset < startOffset) {
            this.output.pushMarkup(" ".repeat(startOffset - this.offset));
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
            case "yaml":
            case "code":
            case "math":
            case "html":
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
                this.output.pushMarkup("", "\n");
                break;
            case "thematicBreak":
                this.output.pushMarkup(emptyMarkup(startOffset, endOffset), "\n\n");
                this.offset = endOffset;
                break;
        }

        // Padding
        if (this.offset < endOffset) {
            this.output.pushMarkup(" ".repeat(endOffset - this.offset));
            this.offset = endOffset;
        }
    }
}

/// Adds text to the output, handling escape characters
function addText(text: string, output: AnnotatedText) {
    // There are probably escape characters
    // It is not really clear why mdast did remove the escape nodes, but here we are

    // Find escapes
    let offset = 0;
    for (const match of text.matchAll(ESCAPE)) {
        const start = match.index;
        // Could span over multiple lines
        output.pushText(text.slice(offset, start));
        // The escape is markup standing for the escaped character, so no edit can split it
        output.pushMarkup(text.slice(start, start + 2), text.slice(start + 1, start + 2));
        offset = start + 2;
    }
    output.pushText(text.slice(offset));
}

function addLines(text: string, parsed: string, output: AnnotatedText) {
    const [first, ...reminder] = text.replace(/\n$/, "").split("\n");
    // The first parsed line is intentionally unused; only the remaining lines are compared.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pfirst is needed to collect premider.
    const [pfirst, ...premider] = parsed.replace(/\n$/, "").split("\n");

    if (reminder.length !== premider.length) {
        console.error("Invalid number of lines", reminder.length, premider.length, text, parsed);
        throw Error("Markdown parsing: invalid number of lines");
    }

    addText(first, output);

    for (let i = 0; i < reminder.length; i++) {
        const line = reminder[i];
        const pline = premider[i];

        let indent = line.length - pline.length;
        // The match value is intentionally unused; each match represents one escape character.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the match count affects indent.
        for (const m of line.matchAll(ESCAPE)) {
            indent -= 1; // each escape character is one longer
        }
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
