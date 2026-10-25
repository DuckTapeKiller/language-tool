/** Types and helpers shared by the Spanish rules */

export interface RuleMatch {
    ruleId: string;
    categoryId: string;
    from: number;
    to: number;
    title: string;
    message: string;
    replacements: string[];
}

export interface Context {
    /// Ranges of the text that are headings
    headings: readonly { from: number; to: number }[];
}

export type Rule = (text: string, context: Context) => RuleMatch[];

/// Narrow no-break space, as LanguageTool also suggests between a number and its unit
export const THIN_SPACE = " ";

/// Abbreviations whose full stop may precede a closing quotation mark or bracket
/// Abbreviations, which keep their full stop: titles, references and plurals of doubled
/// letters («JJ. OO.», «EE. UU.»)
export const ABBREVIATIONS =
    /(?:^|[\s(«“"‘—―])(?:etc|p\. ej|ej|Sr|Sra|Srta|Dr|Dra|D|Dña|Ud|Uds|Ing|Lic|Arq|Prof|Profa|Mons|Excmo|Excma|Ilmo|Ilma|Rmo|Rma|Rdo|Rda|Rvdo|Rvda|Rvdmo|Rvdma|Sto|Sta|Mtro|Mtra|Gral|Cía|Hno|Hna|Hnos|Avda|Av|pág|págs|p|pp|cap|vol|n|núm|art|ed|eds|trad|coord|cf|vid|ss|ca|aprox|fol|fig|figs|op\. cit|id|ib|ibid|tel|máx|mín|a\. C|d\. C|EE\. UU|([A-ZÁÉÍÓÚÑ])\1|[A-ZÁÉÍÓÚÑa-zñ])$/u;

export const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
/// The word with the case of its first letter taken from `like`
export const caseLike = (word: string, like: string) =>
    isUpper(like.charAt(0)) ? upperFirst(word) : word;

/** Whether the position starts a sentence: after nothing, a line break or a sentence end */
export function sentenceStart(text: string, pos: number): boolean {
    const before = text.slice(0, pos).replace(/[\s«“"‘(¿¡—―-]+$/u, "");
    return !before || /[.!?:\n…]$/.test(before) || /\n\s*$/.test(text.slice(0, pos));
}

/** The lines of the text, with the position where each starts */
export function lines(text: string): { line: string; start: number }[] {
    const result: { line: string; start: number }[] = [];
    let start = 0;
    for (const line of text.split("\n")) {
        result.push({ line, start });
        start += line.length + 1;
    }
    return result;
}

/// A vowel with or without its accent, to match words written either way
const VOWELS: Record<string, string> = { a: "[aáà]", e: "[eéè]", i: "[ií]", o: "[oó]", u: "[uúü]" };
/**
 * A regular expression source matching the words with or without accents on their vowels,
 * either apostrophe and any spacing between them. Use it with the "i" flag.
 */
export function anyAccents(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/[aeiou]/gi, v => VOWELS[v.toLowerCase()])
        .replace(/['’]/g, "['’]")
        .replace(/ +/g, "\\s+");
}

/// Words of other languages, as in a quoted title: «What Is Dowsing?», «Mais que doit on…?»
export const FOREIGN = new RegExp(
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
