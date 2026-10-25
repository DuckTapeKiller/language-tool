/**
 * Abbreviations of several words take a space after each full stop: «EE. UU.», «a. C.»
 * (Libro de estilo: abreviaturas; espacios de no separación). The list is that of the
 * Libro de estilo's appendix, except «p. ej.», which LanguageTool already checks.
 */

import { Rule, RuleMatch } from "./common";

const SPACED = [
    "a. e. c.",
    "a. n. e.",
    "A. D.",
    "A. T.",
    "aa. vv.",
    "AA. VV.",
    "b. l. m.",
    "Bs. As.",
    "c. c. o.",
    "c. c. p.",
    "c. c.",
    "C. P.",
    "cta. cte.",
    "D. E. P.",
    "D. L.",
    "e. g.",
    "e. p. d.",
    "i. e.",
    "loc. cit.",
    "N. B.",
    "N. del A.",
    "N. del T.",
    "N. T.",
    "Ntra. Sra.",
    "ob. cit.",
    "op. cit.",
    "P. D.",
    "P. S.",
    "P. V. P.",
    "q. D. g.",
    "q. e. p. d.",
    "R. I. P.",
    "r. p. m.",
    "S. A.",
    "S. L.",
    "S. M.",
    "S. R. L.",
    "s. e.",
    "s. f.",
    "s. l.",
    "s. n.",
    "s. s. s.",
    "V. O. S.",
    "V. O.",
    "v. g.",
    "v. gr.",
    "vv. aa.",
    "VV. AA.",
];

/// The written variants of an abbreviation: «S.A.», «S. A.», «S.  A.»
const variants = (abbreviation: string) =>
    abbreviation.replace(/[.]/g, "\\.").replace(/ /g, "[ \\t]*");

const LISTED = new RegExp(
    `(^|[^\\p{L}\\p{N}.])(${[...SPACED]
        .sort((a, b) => b.length - a.length)
        .map(variants)
        .join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
);
/// Plural abbreviations that are not acronyms: «EEUU», «EE.UU.» → «EE. UU.»
const DOUBLED: Record<string, string> = { EE: "UU", RR: "HH", JJ: "OO", FF: "AA" };
const PLURAL = /(^|[^\p{L}\p{N}.])(EE|RR|JJ|FF)\.?[ \t]*(UU|HH|OO|AA)\.?(?![\p{L}\p{N}])/gu;
/// After a year or a century: «384 a.C.», «siglo V d.C.»
const ERA =
    /(\d|\b[IVXLCDM]+)([ \t]+)([ad])\.[ \t]*(de[ \t]+)?(J\.[ \t]*)?[cC](\.|(?![\p{L}\p{N}]))/gu;
/// After a time: «10am», «10 a.m.», «10:30 PM»
const MERIDIEM =
    /(^|[^\p{L}\p{N}])(\d{1,2}(?:[:.]\d{2})?)[ \t]?([aApP])\.?[ \t]?[mM](\.|(?![\p{L}\p{N}]))/gu;
/// Initials of a name: «J.L. González» → «J. L. González»
const INITIALS = /(^|[^\p{L}\p{N}.])((?:\p{Lu}\.){2,})(?=[ \t]+\p{Lu}\p{Ll})/gu;
const ENGLISH = new Set(["U.S.", "U.K.", "U.N.", "U.S.A."]);

const MESSAGE =
    "Las abreviaturas de varias palabras llevan un espacio tras cada punto: «EE. UU.», «a. C.», «10 a. m.».";

export const abbreviationRule: Rule = text => {
    const found: RuleMatch[] = [];
    const report = (from: number, written: string, right: string, message = MESSAGE) => {
        if (written === right) return;
        const to = from + written.length;
        if (found.some(m => m.from < to && m.to > from)) return;
        found.push({
            ruleId: "RAE_ABREVIATURA_ESPACIO",
            categoryId: "TYPOGRAPHY",
            from,
            to,
            title: "Espacio en la abreviatura",
            message,
            replacements: [right],
        });
    };
    for (const m of text.matchAll(ERA)) {
        const [, , space, era, de, j] = m;
        const from = m.index + m[1].length + space.length;
        report(
            from,
            m[0].slice(m[1].length + space.length),
            `${era}. ${de ? "de " : ""}${j ? "J. " : ""}C.`,
        );
    }
    for (const m of text.matchAll(MERIDIEM)) {
        const from = m.index + m[1].length;
        report(from, m[0].slice(m[1].length), `${m[2]} ${m[3].toLowerCase()}. m.`);
    }
    for (const m of text.matchAll(PLURAL)) {
        if (DOUBLED[m[2]] !== m[3]) continue;
        report(
            m.index + m[1].length,
            m[0].slice(m[1].length),
            `${m[2]}. ${m[3]}.`,
            `«${m[2]}. ${m[3]}.» es una abreviatura, no una sigla: se escribe con un punto tras cada par de letras y un espacio entre ellos.`,
        );
    }
    for (const m of text.matchAll(LISTED)) {
        const written = m[2];
        const right = SPACED.find(a => new RegExp(`^${variants(a)}$`, "u").test(written));
        if (right) report(m.index + m[1].length, written, right);
    }
    for (const m of text.matchAll(INITIALS)) {
        const written = m[2];
        // English abbreviations, as in a quoted title: «U.S. Sees as Useless»
        if (ENGLISH.has(written)) continue;
        report(
            m.index + m[1].length,
            written,
            written.replace(/\.(?=\p{Lu})/gu, ". "),
            "Las iniciales de un nombre van separadas por un espacio: «J. L. González».",
        );
    }
    return found;
};
