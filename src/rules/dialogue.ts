/**
 * Dashes in dialogue and in asides (Libro de estilo, puntuación: la raya; diálogos).
 * A line that starts with a dash is dialogue, or an item of a list; any other dash
 * delimits an aside, which needs a raya at both ends.
 */

import { ABBREVIATIONS, isUpper, lines, Rule, RuleMatch } from "./common";
import { CLITICS, DICENDI } from "./dicendi";

interface Dash {
    at: number;
    ch: string;
}

const isRaya = (ch: string) => ch === "—" || ch === "―";
const isSpace = (ch: string | undefined) => ch === " " || ch === "\t";

const isWordChar = (ch: string | undefined) => /[\p{L}\p{N}]/u.test(ch ?? "");

/**
 * The dashes of a line: rayas, en dashes that are not inside a word, and hyphens that
 * stand apart from a word on one side at least («la subasta - la mayor», «dinásticas- se»),
 * or any hyphen not inside a word if `loose`. Ranges and operations between numbers
 * («1998 – 2012») are not dashes, nor are hyphens of compounds («teórico-práctico») or of
 * coordinated prefixes («pre- y posnatal»).
 */
function dashes(line: string, loose = false): Dash[] {
    const found: Dash[] = [];
    for (let at = 0; at < line.length; at++) {
        const ch = line[at];
        if (isRaya(ch)) {
            found.push({ at, ch });
            continue;
        }
        if (ch !== "–" && ch !== "-") continue;
        if (/\d\s*$/.test(line.slice(0, at)) && /^\s*\d/.test(line.slice(at + 1))) continue;
        const before = line[at - 1];
        const after = line[at + 1];
        const inWord = isWordChar(before) && isWordChar(after);
        if (ch === "–" || loose) {
            if (!inWord) found.push({ at, ch });
            continue;
        }
        if (/^[ \t]+(?:y|e|o|u|ni)[ \t]+\p{L}/u.test(line.slice(at + 1)) && isWordChar(before))
            continue;
        const start = !line.slice(0, at).trim();
        const spaceBefore = isSpace(before) || start;
        const spaceAfter = isSpace(after) || after === undefined;
        if (
            (spaceBefore && (spaceAfter || isWordChar(after))) ||
            (isWordChar(before) && (spaceAfter || /[,;:.)…]/.test(after)))
        )
            found.push({ at, ch });
    }
    return found;
}

/**
 * The position of the end of the sentence that goes on at `from`, or -1: a full stop,
 * question or exclamation mark or ellipsis followed by the end of the line or a new
 * sentence, which starts with a capital or an opening sign.
 */
function sentenceEnd(line: string, from: number): number {
    for (let i = from; i < line.length; i++) {
        const ch = line[i];
        if (!".?!…".includes(ch) || !(i + 1 === line.length || isSpace(line[i + 1]))) continue;
        const next = line
            .slice(i + 1)
            .trimStart()
            .charAt(0);
        if (next && !/[\p{Lu}¿¡«“"—―]/u.test(next)) continue;
        if (ch === "." && line[i - 1] !== "." && ABBREVIATIONS.test(line.slice(0, i))) continue;
        return i;
    }
    return -1;
}

/// Where a word ends, starting at `from`; opening signs before it belong to it
function wordEnd(line: string, from: number): number {
    let to = from;
    while ("¿¡«“".includes(line[to] ?? "x")) to++;
    while (to < line.length && /[\p{L}\p{N}]/u.test(line[to])) to++;
    return to;
}

const NARRATOR_MESSAGE =
    "Si el comentario del narrador lleva un verbo de habla («dijo», «contestó», «preguntó»), la intervención no se cierra con punto ni coma delante de la raya, y el comentario empieza con minúscula: «—Hola —dijo Juan»; «—¿Vienes? —preguntó».";
const DIALOGUE_MESSAGE =
    "En el diálogo se usa la raya (—), no el guion ni la semirraya, y va pegada a las palabras que introduce y separada por un espacio de lo que queda fuera: «—Bien —contestó Juan—. ¿Tú?».";

/**
 * The narrator's comment that a dash opens after a character's words: the full stop or
 * comma before the dash goes if the comment starts with a verb of saying, which is in
 * lower case. With `raya`, the dash and its spaces are put right too, as in dialogue.
 */
function narratorOpening(line: string, dash: Dash, raya?: string): RuleMatch | null {
    const at = dash.at;
    let speechEnd = at;
    while (isSpace(line[speechEnd - 1])) speechEnd--;
    if (speechEnd === 0) return null;
    let wordStart = at + 1;
    if (raya) while (isSpace(line[wordStart])) wordStart++;
    const rest = line.slice(wordStart);
    const clitic = CLITICS.exec(rest)?.[0] ?? "";
    const verb = /^\p{L}+/u.exec(rest.slice(clitic.length))?.[0] ?? "";
    const dicendi = DICENDI.has(verb.toLowerCase());
    const head = clitic.trimEnd() || verb;

    const mark = line[speechEnd - 1];
    const removeMark =
        dicendi &&
        (/[,;:]/.test(mark) ||
            (mark === "." &&
                line[speechEnd - 2] !== "." &&
                !ABBREVIATIONS.test(line.slice(0, speechEnd - 1))));
    const lower = dicendi && isUpper(head.charAt(0));
    const glyph = raya !== undefined && dash.ch !== raya;
    const gap = raya !== undefined && at - speechEnd !== 1;
    const spaceAfter = wordStart > at + 1;
    if (!removeMark && !lower && !glyph && !gap && !spaceAfter) return null;

    const from = removeMark ? speechEnd - 1 : gap ? speechEnd : at;
    const withWord = lower || spaceAfter;
    const to = withWord ? wordStart + head.length : at + 1;
    const word = lower ? head.charAt(0).toLowerCase() + head.slice(1) : head;
    const replacement = (removeMark || gap ? " " : "") + (raya ?? dash.ch) + (withWord ? word : "");
    const narrator = removeMark || lower;
    return {
        ruleId: narrator ? "RAE_INCISO_NARRADOR" : "RAE_RAYA_DIALOGO",
        categoryId: narrator ? "PUNCTUATION" : "TYPOGRAPHY",
        from,
        to,
        title: narrator ? "Inciso del narrador" : "Raya de diálogo",
        message: narrator ? NARRATOR_MESSAGE : DIALOGUE_MESSAGE,
        replacements: [replacement],
    };
}

/** The dash that closes the narrator's comment: «—Bien —contestó Juan—. ¿Tú?» */
function narratorClosing(line: string, dash: Dash, raya: string): RuleMatch | null {
    let end = dash.at;
    while (isSpace(line[end - 1])) end--;
    if (end === dash.at && dash.ch === raya) return null;
    let from = end;
    while (from > 0 && /[\p{L}\p{N}]/u.test(line[from - 1])) from--;
    if (from === end) return null;
    return {
        ruleId: "RAE_RAYA_DIALOGO",
        categoryId: "TYPOGRAPHY",
        from,
        to: dash.at + 1,
        title: "Raya de diálogo",
        message: DIALOGUE_MESSAGE,
        replacements: [line.slice(from, end) + raya],
    };
}

/// The narrator's comment after a dash starts with a verb of saying: «—dijo», «—le contestó»
function saying(line: string, dash: Dash): boolean {
    const rest = line
        .slice(dash.at + 1)
        .trimStart()
        .replace(CLITICS, "");
    return DICENDI.has(/^\p{L}+/u.exec(rest)?.[0]?.toLowerCase() ?? "");
}

/// Where a line of dialogue starts: at its dash, also inside quotation marks («— Hola»)
const DIALOGUE_START = /^\s*[«“"]?(?=[—―–-])/u;

/**
 * A line of dialogue: «—Hola —dijo Juan». Items of a list («— agudas») are not, nor are
 * lines that start with hyphens or en dashes unless a verb of saying shows a narrator.
 */
function dialogue(line: string): Dash[] | null {
    const first = DIALOGUE_START.exec(line)?.[0].length;
    if (first === undefined) return null;
    const raya = isRaya(line[first]);
    const found = dashes(line, !raya);
    if (found[0]?.at !== first) return null;
    const next = line
        .slice(first + 1)
        .trimStart()
        .charAt(0);
    if (!/[\p{L}\p{N}¿¡«…]/u.test(next)) return null;
    if (!raya) return found.some((dash, k) => k % 2 === 1 && saying(line, dash)) ? found : null;
    return found.length > 1 || next === "¿" || next === "¡" ? found : null;
}

function dialogueMatches(line: string): RuleMatch[] {
    const found = dialogue(line);
    if (!found) return [];
    const raya = found[0].ch === "―" ? "―" : "—";
    const matches: RuleMatch[] = [];
    // The dash that opens the character's words: «— Hola» → «—Hola»
    const open = found[0];
    let start = open.at + 1;
    while (isSpace(line[start])) start++;
    if (open.ch !== raya || start > open.at + 1) {
        const end = wordEnd(line, start);
        matches.push({
            ruleId: "RAE_RAYA_DIALOGO",
            categoryId: "TYPOGRAPHY",
            from: open.at,
            to: end,
            title: "Raya de diálogo",
            message: DIALOGUE_MESSAGE,
            replacements: [raya + line.slice(start, end)],
        });
    }
    // Then the narrator's comments, each opened and, if the character goes on, closed
    for (let k = 1; k < found.length; k++) {
        const match =
            k % 2 === 1
                ? narratorOpening(line, found[k], raya)
                : narratorClosing(line, found[k], raya);
        if (match) matches.push(match);
    }
    return matches;
}

const ASIDE_MESSAGE =
    "La raya de inciso va pegada a la primera y a la última palabra del inciso, y separada por un espacio de lo que queda fuera.";

/// What starts an aside: a small letter, a digit or an opening sign, not a title («— Relación…»)
const ASIDE_START = /^[\p{Ll}\p{N}¿¡«“"(]/u;

function asideMatches(line: string): RuleMatch[] {
    // Dialogue and lists start with a dash
    if (DIALOGUE_START.test(line)) return [];
    const list = /^\s*•/.test(line);
    const found = dashes(line);
    const matches: RuleMatch[] = [];
    for (let k = 0; k < found.length; k++) {
        const open = found[k];
        const end = sentenceEnd(line, open.at + 1);
        const next = found[k + 1];
        const close = next && (end < 0 || next.at < end) ? next : null;
        const spaceBefore = open.at === 0 || /[\s(«“"‘[]/.test(line[open.at - 1]);
        if (close) {
            k++;
            const inner = line.slice(open.at + 1, close.at);
            const trimmed = inner.trim();
            if (!trimmed) continue;
            const spaceAfter =
                close.at + 1 === line.length || !/[\p{L}\p{N}]/u.test(line[close.at + 1]);
            const rayas = isRaya(open.ch) && isRaya(close.ch);
            // Hyphens and en dashes also separate names and titles: «Madrid - Barcelona -
            // Valencia», «Adolfo Mejía - Viajero de mí mismo - YouTube»
            if (!rayas && (!/\s/.test(trimmed) || !ASIDE_START.test(trimmed))) continue;
            // A hyphen that opens is apart from the word before it, and one that closes is
            // joined to it or between spaces; otherwise they are suffixes: «-isa o -esa»
            if (
                !rayas &&
                (!spaceBefore || (isSpace(line[close.at - 1]) && isWordChar(line[close.at + 1])))
            )
                continue;
            // Dashes that separate clauses of a list: «está vivo — no está muerto; …»
            if (trimmed.includes(";")) continue;
            if (rayas && trimmed === inner && spaceBefore && spaceAfter) continue;
            const raya = rayas && open.ch === close.ch ? open.ch : "—";
            matches.push({
                ruleId: rayas ? "RAE_RAYA_PEGADA" : "RAE_RAYA_INCISO",
                categoryId: "TYPOGRAPHY",
                from: open.at,
                to: close.at + 1,
                title: rayas ? "Espacios dentro de las rayas" : "Raya en el inciso",
                message: rayas
                    ? ASIDE_MESSAGE
                    : "Los incisos se escriben entre rayas (—), no entre guiones ni semirrayas. " +
                      ASIDE_MESSAGE,
                replacements: [
                    (spaceBefore ? "" : " ") + raya + trimmed + raya + (spaceAfter ? "" : " "),
                ],
            });
            continue;
        }
        // An aside that runs to the end of the sentence still needs its closing raya
        if (end < 0 || open.ch === "-" || (list && !isRaya(open.ch)) || !spaceBefore) continue;
        const inner = line.slice(open.at + 1, end).trim();
        if (!/\s/.test(inner) || /[»”")\]]/.test(inner) || !ASIDE_START.test(inner)) continue;
        // Dialogue quoted in a paragraph: «Correcta: —¡No puedo oírte! —gritó Kismine»
        if (/^[¿¡]/u.test(inner)) continue;
        // A separator before an address: «Marsillach — palabravirtual.com»
        if (/\.\p{L}{2,}$|www\.|:\/\//u.test(inner)) continue;
        // A narrator's comment, as in «"No vendré" —dijo Juan.»
        const verb = /^\p{L}+/u.exec(inner.replace(CLITICS, ""))?.[0] ?? "";
        if (DICENDI.has(verb.toLowerCase())) continue;
        const raya = isRaya(open.ch) ? open.ch : "—";
        let to = end;
        while (isSpace(line[to - 1])) to--;
        matches.push({
            ruleId: "RAE_RAYA_CIERRE",
            categoryId: "PUNCTUATION",
            from: open.at,
            to,
            title: "Falta la raya de cierre",
            message:
                "El inciso entre rayas se cierra con otra raya, también al final del enunciado: «Se llama José Luis —al menos que yo sepa—».",
            replacements: [raya + inner + raya],
        });
    }
    // A narrator's comment inside a paragraph: «Hola, —Dijo Juan—, ¿qué tal?»
    for (const dash of found) {
        if (!isRaya(dash.ch) || !/\p{L}/u.test(line[dash.at + 1] ?? "")) continue;
        const match = narratorOpening(line, dash);
        if (match) matches.push(match);
    }
    return matches;
}

/** Dialogue punctuation and dashes in asides */
export const dashRules: Rule = text =>
    lines(text).flatMap(({ line, start }) =>
        [...dialogueMatches(line), ...asideMatches(line)].map(m => ({
            ...m,
            from: start + m.from,
            to: start + m.to,
        })),
    );
