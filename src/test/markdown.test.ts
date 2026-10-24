import { describe, expect, test } from "bun:test";
import * as Bun from "bun";
import { SyntaxTree } from "../markdown/parser";

describe("markdown parsing", () => {
    test("hello world", () => {
        let input = "Hello world";
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: input });
    });

    test("wiki link", () => {
        let input = "Hello [[World]]!";
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        // "[[" opens the link and "]]" closes it
        expect(annotations.annotations[1]).toStrictEqual({
            markup: "  ",
            interpretAs: undefined,
            attach: "next",
        });
        expect(annotations.annotations[2]).toStrictEqual({ text: "World" });
        expect(annotations.annotations[3]).toStrictEqual({
            markup: "  ",
            interpretAs: undefined,
            attach: "previous",
        });
        expect(annotations.annotations[4]).toStrictEqual({ text: "!" });

        expect(syntax.isInside(9, "wikiLink")).toBeTrue();
        expect(!syntax.isInside(3, "wikiLink")).toBeTrue();
    });

    test("wiki link with alias", () => {
        let input = "Hello [[World|alias]]!";
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        expect(annotations.annotations[1]).toStrictEqual({
            markup: "        ",
            interpretAs: undefined,
            attach: "next",
        });
        expect(annotations.annotations[2]).toStrictEqual({ text: "alias" });
        expect(annotations.annotations[3]).toStrictEqual({
            markup: "  ",
            interpretAs: undefined,
            attach: "previous",
        });
        expect(annotations.annotations[4]).toStrictEqual({ text: "!" });
    });

    test("len error", () => {
        let input = `
- EML attached
    - Here are some examples:
      Just padding text
      [[Here is some link]]
`;
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.trimEnd().length);
    });

    test("simple escape", () => {
        let input = `Hello \\\\world`;
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.length);
        expect(annotations.annotations[0]).toStrictEqual({ text: "Hello " });
        // The escape is markup standing for the escaped character
        expect(annotations.annotations[1]).toStrictEqual({ markup: "\\\\", interpretAs: "\\" });
        expect(annotations.annotations[2]).toStrictEqual({ text: "world" });
    });

    test("many escapes", () => {
        let input = `\\!\\"\\#\\$\\%\\&\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\\`\\{\\|\\}\\~`;
        let syntax = new SyntaxTree(input);
        let { annotations } = syntax.annotate(undefined);
        expect(annotations.length()).toBe(input.length);
        for (let i = 0; i < input.length; i += 2) {
            expect(annotations.annotations[i / 2]).toStrictEqual({
                markup: input.slice(i, i + 2),
                interpretAs: input[i + 1],
            });
        }
        // ...
    });
});

test("excludes math", () => {
    const input = "Some math $x_i$ after.\n\n$$\n\\frac{a}{b}\n$$\n\nEnd.";
    const { annotations } = new SyntaxTree(input).annotate();

    expect(annotations.length()).toBe(input.length);
    expect(annotations.annotations.flatMap(a => ("text" in a ? [a.text] : [])).join("")).toBe(
        "Some math  after.End.",
    );
});

describe("markdown samples", () => {
    // iterate over all files in the samples directory
    const files = [...new Bun.Glob("*").scanSync("test")];
    for (const file of files) {
        test(`sample ${file}`, async () => {
            const input = await Bun.file(`test/${file}`).text();
            let syntax = new SyntaxTree(input);
            let { annotations } = syntax.annotate(undefined);
            expect(annotations.length()).toBe(input.trimEnd().length);
        });
    }
});

test("annotates only the selected block", () => {
    const input = "first\n\na typo";
    const syntax = new SyntaxTree(input);
    const result = syntax.annotate({ from: 7, to: 12 });

    expect(result.offset).toBe(7);
    expect(result.annotations.annotations.length).toBeGreaterThanOrEqual(1);
    expect(result.annotations.annotations[0]).toStrictEqual({ text: "a typo" });
});

test("a malformed link with an email address does not stop the check", () => {
    // GFM turns the email into nodes without a position, which used to throw
    const input =
        "Before.\n\n[tallerforn@gmail.com](http://tallerforn@gmail.com/ «tallerforn@gmail.com»)\n\nAfter the link.";
    const syntax = new SyntaxTree(input);
    const { annotations } = syntax.annotate(undefined);
    const text = annotations.annotations.map(a => ("text" in a ? a.text : "")).join("");
    expect(text).toContain("Before.");
    expect(text).toContain("After the link.");
    expect(annotations.length()).toBe(input.length);
});
