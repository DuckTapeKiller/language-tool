/**
 * Latin phrases and unadapted foreign expressions, which go in italics and, being Latin,
 * without accents (Libro de estilo: locuciones, dichos o citas en otras lenguas):
 * *in situ*, *grosso modo*, *motu proprio*, *curriculum vitae*, *déjà vu*.
 */

import { anyAccents, caseLike } from "./common";

interface Expression {
    /// The written form
    right: string;
    /// Other forms that are also right: «alea jacta est»
    also?: string[];
    /// Forms that are wrong, besides those with accents: «status quo», «a grosso modo»
    wrong?: string[];
}

const LATIN = `a contrario|a fortiori|a posteriori|a priori|ab initio|ab intestato|ad hoc|ad honorem
ad infinitum|ad libitum|ad litteram|ad nauseam|ad pedem litterae|ad referendum|bona fide|casus belli
corpore insepulto|cum laude|curriculum vitae|de facto|deus ex machina|ex aequo|ex cathedra|ex libris
ex nihilo|ex novo|habeas corpus|honoris causa|in absentia|in aeternum|in albis|in crescendo
in dubio pro reo|in extenso|in extremis|in illo tempore|in medias res|in memoriam|in pectore|in situ
in vitro|in vivo|inter alia|inter nos|ipso facto|lapsus linguae|lapsus calami|magna cum laude
manu militari|modus operandi|modus vivendi|mutatis mutandis|nihil obstat|non plus ultra
numerus clausus|peccata minuta|per capita|per se|persona non grata|post mortem|post scriptum
prima facie|pro bono|pro forma|quid pro quo|rara avis|sine die|conditio sine qua non|sine qua non
stricto sensu|lato sensu|sui generis|summa cum laude|ultima ratio|urbi et orbi|vade retro
verbi gratia|vox populi|carpe diem|et al.|et alii|op. cit.|loc. cit.|ibid.|ibidem|passim
déjà vu|femme fatale|top secret|c'est la vie|vis a vis`;

const EXPRESSIONS: Expression[] = [
    ...LATIN.split(/[|\n]/).map(right => ({ right: right.trim() })),
    { right: "alea iacta est", also: ["alea jacta est"] },
    { right: "de iure", also: ["de jure"] },
    { right: "grosso modo", wrong: ["a grosso modo"] },
    { right: "motu proprio", wrong: ["de motu proprio", "de motu propio", "motu propio"] },
    { right: "statu quo", wrong: ["status quo"] },
];

const FORMS = EXPRESSIONS.flatMap(e =>
    [e.right, ...(e.also ?? []), ...(e.wrong ?? [])].map(written => ({ written, expression: e })),
).sort((a, b) => b.written.length - a.written.length);

const PATTERN = new RegExp(
    `(^|[^\\p{L}])(${FORMS.map(f => anyAccents(f.written)).join("|")}|sic)(?![\\p{L}])`,
    "giu",
);
const key = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").replace(/’/g, "'").replace(/\s+/g, " ").toLowerCase();

export interface ForeignPhrase {
    from: number;
    to: number;
    written: string;
    right: string;
}

/** Whether the position is inside quotation marks on its line: a citation keeps its text */
function quoted(text: string, at: number): boolean {
    const line = text.slice(text.lastIndexOf("\n", at) + 1, at);
    const count = (chars: RegExp) => (line.match(chars) ?? []).length;
    return count(/«/g) > count(/»/g) || count(/“/g) > count(/”/g) || count(/"/g) % 2 === 1;
}

/** The Latin and foreign expressions in the text, and how each is written */
export function foreignPhrases(text: string): ForeignPhrase[] {
    const found: ForeignPhrase[] = [];
    for (const m of text.matchAll(PATTERN)) {
        const written = m[2];
        const from = m.index + m[1].length;
        const to = from + written.length;
        if (quoted(text, from)) continue;
        let right = "sic";
        if (key(written) === "sic") {
            // Only «(sic)» and «[sic]»: the Latin word that marks a quotation as faithful
            if (!"([".includes(text[from - 1] ?? "x") || !")]".includes(text[to] ?? "x")) continue;
        } else {
            // A name or a title in title case: the collection «Rara Avis»
            if (/\s\p{Lu}/u.test(written)) continue;
            const form = FORMS.find(f => key(f.written) === key(written));
            if (!form) continue;
            const { expression } = form;
            const accepted = [expression.right, ...(expression.also ?? [])];
            right = accepted.includes(form.written) ? form.written : expression.right;
        }
        found.push({ from, to, written, right: caseLike(right, written) });
    }
    return found;
}
