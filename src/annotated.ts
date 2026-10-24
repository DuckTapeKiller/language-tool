export type Annotation = { text: string } | { markup: string; interpretAs?: string };

/** A replacement of the raw text between `from` and `to` */
export interface TextEdit {
    from: number;
    to: number;
    insert: string;
}

/** Annotated text with optional markup for LanguageTool */
export class AnnotatedText {
    annotations: Annotation[];

    constructor(annotations: Annotation[] = []) {
        this.annotations = annotations;
    }

    pushText(text: string) {
        if (text.length > 0) this.annotations.push({ text });
    }

    pushMarkup(markup: string, interpretAs?: string) {
        this.annotations.push({ markup, interpretAs });
    }

    extend(other: AnnotatedText) {
        for (const a of other.annotations) {
            if ("text" in a) this.pushText(a.text);
            else this.pushMarkup(a.markup, a.interpretAs);
        }
    }

    /**
     * Turn the text in the ranges into markup, so it is not checked or changed.
     * `base` is the position of this text in the note, which the ranges refer to.
     */
    hide(ranges: readonly { from: number; to: number }[], base: number) {
        if (!ranges.length) return;
        const output: Annotation[] = [];
        let pos = base;
        for (const a of this.annotations) {
            if (!("text" in a)) {
                output.push(a);
                pos += a.markup.length;
                continue;
            }
            const start = pos;
            const end = (pos += a.text.length);
            let cut = start;
            for (const r of ranges) {
                if (r.to <= cut || r.from >= end) continue;
                const from = Math.max(r.from, cut);
                const to = Math.min(r.to, end);
                if (from > cut) output.push({ text: a.text.slice(cut - start, from - start) });
                output.push({ markup: a.text.slice(from - start, to - start) });
                cut = to;
            }
            if (cut < end) output.push({ text: a.text.slice(cut - start) });
        }
        this.annotations = output;
    }

    /** Merge compatible annotations to reduce the length, returning the start offset */
    optimize(): number {
        const output: Annotation[] = [];
        for (const a of this.annotations) {
            if (
                ("text" in a && a.text.length === 0) ||
                ("markup" in a && a.markup.length === 0 && !a.interpretAs)
            )
                continue;

            const last = output.at(-1);
            if (last === undefined) {
                output.push(a);
            } else {
                if ("text" in last && "text" in a) {
                    last.text += a.text;
                } else if ("markup" in last && "markup" in a) {
                    last.markup += a.markup;
                    if (last.interpretAs && a.interpretAs) last.interpretAs += a.interpretAs;
                    else if (a.interpretAs) last.interpretAs = a.interpretAs;
                } else {
                    output.push(a);
                }
            }
        }
        for (const a of output) {
            if ("markup" in a && a.interpretAs) {
                // replace more than two new lines with two new lines
                a.interpretAs = a.interpretAs.replace(/\n{3,}/g, "\n\n");
            }
        }
        // Markup that reads as nothing (an image, an HTML tag, a comment) between two spaces
        // would leave a double space; one of the spaces becomes part of the markup instead
        for (let i = 1; i < output.length - 1; i++) {
            const [before, a, after] = [output[i - 1], output[i], output[i + 1]];
            if (!("markup" in a) || a.interpretAs || !("text" in before) || !("text" in after))
                continue;
            if (/[ \t]$/.test(before.text) && /^[ \t]/.test(after.text)) {
                a.markup = before.text.slice(-1) + a.markup;
                before.text = before.text.slice(0, -1);
            }
        }
        // remove markup from the end
        for (let a = output.at(-1); a && "markup" in a; a = output.at(-1)) {
            output.pop();
        }
        // remove markup from the start
        let offset = 0;
        for (let a = output.at(0); a && "markup" in a; a = output.at(0)) {
            offset += a.markup.length;
            output.shift();
        }
        this.annotations = output;
        return offset;
    }

    /**
     * The checked text and, for each of its characters, the raw position it comes from
     * (null for characters that markup stands for, such as the line breaks between blocks).
     */
    plainText(): { text: string; raw: (number | null)[] } {
        let text = "";
        const raw: (number | null)[] = [];
        let pos = 0;
        for (const a of this.annotations) {
            if ("text" in a) {
                text += a.text;
                for (let i = 0; i < a.text.length; i++) raw.push(pos + i);
                pos += a.text.length;
            } else {
                const interpreted = a.interpretAs ?? "";
                text += interpreted;
                for (let i = 0; i < interpreted.length; i++) raw.push(null);
                pos += a.markup.length;
            }
        }
        return { text, raw };
    }

    /** Whether this text is a heading, whose "#" marks are markup at its start */
    isHeading(): boolean {
        const first = this.annotations.find(a => !("markup" in a) || a.markup.trim());
        return !!first && "markup" in first && /^#{1,6}(\s|$)/.test(first.markup.trimStart());
    }

    /**
     * The smallest changes to the raw text in [from, to) that turn its checked text into
     * `replacement`, with positions relative to `from`. Null if a change would touch
     * markup, such as an emphasis marker or a link, as that would break the formatting.
     */
    safeEdits(from: number, to: number, replacement: string): TextEdit[] | null {
        // The checked characters in the range, with their raw positions (null for markup)
        const chars: { ch: string; raw: number | null }[] = [];
        let pos = 0;
        for (const a of this.annotations) {
            const raw = "text" in a ? a.text : a.markup;
            const start = pos;
            const end = (pos += raw.length);
            if ("text" in a) {
                for (let i = Math.max(from, start); i < Math.min(to, end); i++)
                    chars.push({ ch: raw[i - start], raw: i });
            } else if (raw.length === 0 ? from < start && start < to : start < to && end > from) {
                // Markup only partly in the range cannot be kept intact
                if (start < from || end > to) return null;
                for (const ch of a.interpretAs ?? "") chars.push({ ch, raw: null });
            }
            if (start >= to) break;
        }

        const edits: TextEdit[] = [];
        for (const hunk of diff(chars.map(c => c.ch).join(""), replacement)) {
            const changed = chars.slice(hunk.from, hunk.to);
            if (!changed.length) {
                // Insertion: before the next checked character, or after the previous one
                const next = chars[hunk.from]?.raw;
                const previous = chars[hunk.from - 1]?.raw;
                if (next === null && previous === null) return null;
                const at = next ?? (previous != null ? previous + 1 : from);
                edits.push({ from: at - from, to: at - from, insert: hunk.insert });
                continue;
            }
            // Every changed character must be text, without markup in between
            for (let i = 0; i < changed.length; i++) {
                const raw = changed[i].raw;
                if (raw === null) return null;
                if (i > 0 && raw !== changed[i - 1].raw! + 1) return null;
            }
            edits.push({
                from: changed[0].raw! - from,
                to: changed[changed.length - 1].raw! + 1 - from,
                insert: hunk.insert,
            });
        }
        return edits;
    }

    /** The smallest change, or null if it would touch markup (see {@link safeEdits}) */
    safeEdit(from: number, to: number, replacement: string): TextEdit | null {
        const edits = this.safeEdits(from, to, replacement);
        if (!edits) return null;
        if (edits.length <= 1) return edits[0] ?? { from: 0, to: 0, insert: "" };
        // Merge into one change spanning all of them
        const first = edits[0];
        const last = edits[edits.length - 1];
        return { from: first.from, to: last.to, insert: replacement };
    }

    /** Extract a subslice from the annotated text, ignoring any markup */
    extractSlice(from: number, to: number): string | null {
        let i = 0;
        for (; i < this.annotations.length; i++) {
            const annotation = this.annotations[i];
            const content = "text" in annotation ? annotation.text : annotation.markup;
            if (content.length < from) {
                from -= content.length;
                to -= content.length;
            } else {
                break;
            }
        }
        let text = "";
        for (; i < this.annotations.length; i++) {
            const annotation = this.annotations[i];
            if ("text" in annotation) {
                text += annotation.text;
            } else {
                if (text.length < from) {
                    from -= annotation.markup.length;
                    from += annotation.interpretAs?.length || 0;
                }
                text += annotation.interpretAs ?? "";
                to -= annotation.markup.length;
                to += annotation.interpretAs?.length || 0;
            }

            if (text.length >= to) return text.slice(from, to).trim();
        }
        return null;
    }

    length(): number {
        return this.annotations.reduce((acc, a) => {
            if ("text" in a) return acc + a.text.length;
            if ("markup" in a) return acc + a.markup.length;
            return acc;
        }, 0);
    }

    /** Length of the text LanguageTool checks, which is what its size limits apply to */
    plainLength(): number {
        return this.annotations.reduce(
            (acc, a) => acc + ("text" in a ? a.text.length : (a.interpretAs?.length ?? 0)),
            0,
        );
    }

    /** Annotations grouped by the blocks they belong to, which end with a matching line break */
    private blockAnnotations(lineBreak: string): Annotation[][] {
        const blocks: Annotation[][] = [[]];
        for (const a of this.annotations) {
            blocks.at(-1)!.push(a);
            if ("markup" in a && a.interpretAs?.includes(lineBreak)) blocks.push([]);
        }
        return blocks.filter(block => block.length);
    }

    /**
     * Split into paragraphs, list items, headings and table rows.
     * The raw lengths of the parts add up to this length.
     */
    paragraphs(): AnnotatedText[] {
        return this.blockAnnotations("\n\n").map(block => new AnnotatedText(block));
    }

    /** Whether there is any text to check, rather than only markup */
    hasText(): boolean {
        return this.annotations.some(a => "text" in a && a.text.trim().length > 0);
    }

    /**
     * Split into consecutive parts whose plain length is at most `maxLength`,
     * preferably at block boundaries. The raw lengths of the parts add up to this length.
     */
    split(maxLength: number): AnnotatedText[] {
        if (maxLength <= 0 || this.plainLength() <= maxLength) return [this];

        // Blocks end with markup that is interpreted as a line break
        const blocks = this.blockAnnotations("\n");

        const parts: AnnotatedText[] = [];
        let current = new AnnotatedText();
        for (const block of blocks) {
            const blockText = new AnnotatedText(block);
            if (current.plainLength() + blockText.plainLength() <= maxLength) {
                current.annotations.push(...block);
                continue;
            }
            if (current.annotations.length) parts.push(current);
            current = new AnnotatedText();
            // A single block that is too long is split between words
            for (const a of block) {
                const plain = "text" in a ? a.text.length : (a.interpretAs?.length ?? 0);
                if (current.plainLength() + plain <= maxLength) {
                    current.annotations.push({ ...a });
                    continue;
                }
                if (!("text" in a)) {
                    if (current.annotations.length) parts.push(current);
                    current = new AnnotatedText([{ ...a }]);
                    continue;
                }
                let text = a.text;
                while (current.plainLength() + text.length > maxLength) {
                    const room = maxLength - current.plainLength();
                    let cut = text.lastIndexOf(" ", room);
                    if (cut <= 0) cut = room > 0 ? room : Math.min(maxLength, text.length);
                    if (room > 0 || !current.annotations.length) {
                        current.annotations.push({ text: text.slice(0, cut) });
                        text = text.slice(cut);
                    }
                    parts.push(current);
                    current = new AnnotatedText();
                }
                if (text) current.annotations.push({ text });
            }
        }
        if (current.annotations.length) parts.push(current);
        return parts;
    }

    stringify(): string {
        return JSON.stringify({ annotation: this.annotations });
    }
}

/**
 * The changed parts between two strings: ranges of `before` and what replaces them.
 * Common start and end are trimmed first; the middle is aligned character by character.
 */
export function diff(
    before: string,
    after: string,
): { from: number; to: number; insert: string }[] {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
        prefix++;
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    )
        suffix++;
    const a = before.slice(prefix, before.length - suffix);
    const b = after.slice(prefix, after.length - suffix);
    if (!a.length && !b.length) return [];
    // Long middles are replaced as a whole; aligning them would be slow
    if (!a.length || !b.length || a.length * b.length > 40000)
        return [{ from: prefix, to: prefix + a.length, insert: b }];

    // Longest common subsequence of the middles
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            lcs[i][j] =
                a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

    const hunks: { from: number; to: number; insert: string }[] = [];
    let open: { from: number; to: number; insert: string } | null = null;
    let i = 0;
    let j = 0;
    const flush = () => {
        if (open) hunks.push(open);
        open = null;
    };
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            flush();
            i++;
            j++;
        } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
            open ??= { from: prefix + i, to: prefix + i, insert: "" };
            open.insert += b[j++];
        } else {
            open ??= { from: prefix + i, to: prefix + i, insert: "" };
            open.to = prefix + ++i;
        }
    }
    flush();
    return hunks;
}
