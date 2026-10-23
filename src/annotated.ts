export type Annotation = { text: string } | { markup: string; interpretAs?: string };

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
