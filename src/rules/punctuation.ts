/**
 * Question and exclamation marks, which are double in Spanish, and the full stop that
 * headings do not take (Libro de estilo: los signos de interrogación y exclamación;
 * elementos que no se cierran con punto).
 */

import { ABBREVIATIONS, Rule, RuleMatch } from "./common";

const OPENING: Record<string, string> = { "?": "¿", "!": "¡" };
const INTERROGATIVE =
    /^(?:qué|cómo|cuándo|dónde|adónde|quién|quiénes|cuál|cuáles|cuánto|cuánta|cuántos|cuántas|por)$/iu;
/// What goes before a question, outside it: «Juan, ¿vienes?», «Si llueve, ¿vendrás?»
const OUTSIDE =
    /^(?:si|aunque|puesto que|ya que|como|cuando|entonces|pues|bueno|oye|mira|dime|y|o|pero|así que|en cuanto a|por cierto|francamente|sinceramente|a ver|hola|por favor)(?![\p{L}])/iu;
/// Words of other languages, as in a quoted title: «What Is Dowsing?», «Mais que doit on…?»
const FOREIGN = new RegExp(
    "(?:^|[^\\p{L}])(?:" +
        [
            // English
            "the|you|what|is|are|does|did|how|why|who|where|when|this|that|it|will|would|should|could|was|were|my|your|we|they|and|of|to|or|said",
            "(?:can|don|isn|doesn|I)['’](?:t|m)",
            // French
            "il|elle|nous|vous|pas|mais|est|sont|et|du|au|aux|avec|cette|ces|ont|été|être|fait|qui|pour|dans",
            "(?:l|d|qu|c|n|s|j)['’]\\p{L}+",
            // Italian and the Nordic languages
            "della|delle|degli|sono|questo|questa|anche|più|perché|og|ikke|i",
        ].join("|") +
        ")(?![\\p{L}])",
    "iu",
);

const isClosingFollower = (ch: string | undefined) =>
    ch === undefined || /[\s»”"’)\]—―,;:.…*_]/u.test(ch);

/** Where a word ends, starting at `from` */
function wordEnd(line: string, from: number): number {
    let to = from;
    while (to < line.length && /[\p{L}\p{N}]/u.test(line[to])) to++;
    return to;
}

function missingOpening(
    line: string,
    clause: number,
    close: number,
    mark: string,
): RuleMatch | null {
    // A question in quotation marks starts at them: «Dijo "vienes?"»
    for (let i = close - 1; i >= clause; i--) {
        if ("»”".includes(line[i])) break;
        if ("«“".includes(line[i])) {
            clause = i + 1;
            break;
        }
    }
    const segment = line.slice(clause, close);
    // Words of another language or script around it: «Evoè! Música i èxtasi», «Ну, погоди!»
    const around = segment + line.slice(close, close + 40);
    if (FOREIGN.test(around) || /[^\P{L}\p{Script=Latin}]/u.test(segment)) return null;
    if (/:\/\/|www\./.test(segment)) return null;
    const start = clause + segment.search(/[\p{L}\p{N}]/u);
    if (start < clause) return null;
    const sign = OPENING[mark];
    // After the last comma or colon, if what comes before stays outside the question
    let inner = -1;
    const separator = /[,:]\s+(?=[\p{L}\p{N}])/gu;
    for (const m of line.slice(start, close).matchAll(separator))
        inner = start + m.index + m[0].length;
    // A connector, a vocative or a clause before it: «Entonces,», «Señor García,», «Si llueve,»
    const before = line
        .slice(start, inner)
        .replace(/[,:]\s*$/u, "")
        .trim()
        .split(/\s+/);
    const insideFirst =
        inner > 0 &&
        (INTERROGATIVE.test(line.slice(inner, wordEnd(line, inner))) ||
            OUTSIDE.test(before.join(" ")) ||
            before.length === 1 ||
            /^\p{Lu}/u.test(before[before.length - 1]));
    const to = wordEnd(line, inner > 0 ? inner : start);
    const text = line.slice(start, to);
    const atStart = sign + text;
    const replacements =
        inner > 0
            ? [atStart, text.slice(0, inner - start) + sign + text.slice(inner - start)]
            : [atStart];
    if (insideFirst) replacements.reverse();
    const question = mark === "?";
    return {
        ruleId: question ? "RAE_APERTURA_INTERROGACION" : "RAE_APERTURA_EXCLAMACION",
        categoryId: "PUNCTUATION",
        from: start,
        to,
        title: question ? "Falta el signo de apertura «¿»" : "Falta el signo de apertura «¡»",
        message:
            (question
                ? "Los signos de interrogación son dobles en español: la pregunta se abre con «¿»."
                : "Los signos de exclamación son dobles en español: la exclamación se abre con «¡».") +
            " Los vocativos, los conectores y las oraciones con «si» o «aunque» que la preceden quedan fuera: «Juan, ¿vienes?»; «Si llueve, ¿vendrás?».",
        replacements,
    };
}

/**
 * A mark that does not close a question or exclamation of the text: «(?)», «[1617?]» and
 * «[!]» are editorial, «5!» is a factorial, « ?» is French, and a title in the middle of a
 * sentence keeps its own marks: «se publicó como Fake! (1969)», «Yu-Gi-Oh!, de Konami».
 */
function notClosing(text: string, at: number, end: number, segmentStart: number): boolean {
    const before = text[at - 1] ?? "";
    const next = text[end];
    if (!isClosingFollower(next) || /\s/.test(before) || next === "]") return true;
    if (text[at] === "!" && /\d/.test(before)) return true;
    if (next === ")") {
        const opening = text.lastIndexOf("(", at);
        if (opening >= 0 && !/\s/.test(text.slice(opening + 1, at))) return true;
    }
    const after = text.slice(end);
    // The sentence goes on in small letters, or with the year or language of a title:
    // «el Quid fles? de Horacio», «Flim-Flam! (en inglés)», «Nu, pogodí! (1969-1986)»
    if (/^\s+\p{Ll}/u.test(after) || /^\s*\((?:\d|en\s|[^\P{L}\p{Script=Latin}])/u.test(after))
        return true;
    let word = at;
    while (word > 0 && /[\p{L}\p{N}-]/u.test(text[word - 1])) word--;
    const midSentence = text.slice(segmentStart, word).search(/[\p{L}\p{N}]/u) >= 0;
    const ends = /^(?:\s*$|\s+[\p{Lu}¿¡«“"—―])/u.test(after);
    return midSentence && /^\p{Lu}/u.test(text[word] ?? "") && !ends;
}

function blockMatches(line: string): RuleMatch[] {
    const found: RuleMatch[] = [];
    let clause = 0;
    let open = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "¿" || ch === "¡") {
            open++;
            continue;
        }
        // A line of verse may go on with the question of the line before
        if (ch === "\n") {
            clause = i + 1;
            continue;
        }
        if (ch === "." || ch === "…") {
            const after = line[i + 1];
            const abbreviation =
                ch === "." && line[i - 1] !== "." && ABBREVIATIONS.test(line.slice(0, i));
            // «son... italianas» goes on: a new sentence starts with a capital or a sign
            const goesOn = /^\s+\p{Ll}/u.test(line.slice(i + 1));
            if ((after === undefined || /\s/.test(after)) && !abbreviation && !goesOn) {
                clause = i + 1;
                open = 0;
            }
            continue;
        }
        if (ch !== "?" && ch !== "!") continue;
        let end = i;
        while (line[end] === "?" || line[end] === "!") end++;
        const next = line[end];
        if (!notClosing(line, i, end, clause)) {
            if (open > 0) open--;
            else {
                const match = missingOpening(line, clause, i, ch);
                if (match) found.push(match);
            }
            if (next === undefined || /\s/.test(next)) {
                clause = end;
                open = 0;
            } else if (next === "," || next === ";") clause = end + 1;
        }
        i = end - 1;
    }
    // «¿¿Qué??» → «¿Qué?»: repeating question marks is best avoided
    for (const m of line.matchAll(/¿{2,}|\?{2,}/g))
        found.push({
            ruleId: "RAE_INTERROGACION_DOBLE",
            categoryId: "PUNCTUATION",
            from: m.index,
            to: m.index + m[0].length,
            title: "Signos de interrogación repetidos",
            message:
                "Es preferible no repetir los signos de interrogación; para expresar sorpresa se combinan con los de exclamación: «¿¡Qué me estás contando!?».",
            replacements: [m[0][0]],
        });
    return found;
}

/** Opening question and exclamation marks, paragraph by paragraph */
export const questionRules: Rule = text => {
    const found: RuleMatch[] = [];
    for (const m of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g))
        for (const match of blockMatches(m[0]))
            found.push({ ...match, from: m.index + match.from, to: m.index + match.to });
    return found;
};

/** «## La historia de la ciudad.» → «## La historia de la ciudad» */
export const headingStop: Rule = (text, { headings }) => {
    const found: RuleMatch[] = [];
    for (const { from, to } of headings) {
        const heading = text.slice(from, to).trimEnd();
        const dot = from + heading.length - 1;
        if (!heading.endsWith(".") || heading.endsWith("..")) continue;
        // A number alone is a numbering, and an abbreviation keeps its full stop
        if (/^[\dIVXLCDM]+\.$/.test(heading) || ABBREVIATIONS.test(text.slice(from, dot))) continue;
        let start = dot;
        while (start > from && /[\p{L}\p{N}»”)]/u.test(text[start - 1])) start--;
        if (start === dot) continue;
        found.push({
            ruleId: "RAE_PUNTO_TITULO",
            categoryId: "PUNCTUATION",
            from: start,
            to: dot + 1,
            title: "Punto en el título",
            message:
                "Los títulos y encabezamientos que ocupan su propia línea no se cierran con punto.",
            replacements: [text.slice(start, dot)],
        });
    }
    return found;
};
