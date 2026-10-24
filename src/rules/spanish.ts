/**
 * Orthotypographic rules of the RAE's Libro de estilo that LanguageTool does not check.
 * They are mechanical, so they are applied to text LanguageTool has detected as Spanish.
 * Each rule reports a range of the checked text and its replacements.
 */

export interface RuleMatch {
    ruleId: string;
    categoryId: string;
    from: number;
    to: number;
    title: string;
    message: string;
    replacements: string[];
}

interface Context {
    /// Ranges of the text that are headings
    headings: readonly { from: number; to: number }[];
}

type Rule = (text: string, context: Context) => RuleMatch[];

/// Narrow no-break space, as LanguageTool also suggests between a number and its unit
const THIN_SPACE = "\u202f";

const MONTHS = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "setiembre",
    "octubre",
    "noviembre",
    "diciembre",
];
const DAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const TITLES = [
    "rey",
    "reina",
    "papa",
    "presidente",
    "presidenta",
    "ministro",
    "ministra",
    "príncipe",
    "princesa",
    "duque",
    "duquesa",
    "conde",
    "condesa",
    "marqués",
    "marquesa",
    "emperador",
    "emperatriz",
    "alcalde",
    "alcaldesa",
    "obispo",
    "arzobispo",
    "cardenal",
    "senador",
    "senadora",
    "gobernador",
    "gobernadora",
    "virrey",
];
/// Abbreviations whose full stop may precede a closing quotation mark or bracket
const ABBREVIATIONS =
    /(?:^|[\s(«“"‘])(?:etc|p\. ej|Sr|Sra|Srta|Dr|Dra|D|Dña|Ud|Uds|pág|págs|cap|vol|n|núm|art|ed|eds|trad|coord|cf|vid|ss|a\. C|d\. C|EE\. UU|[A-ZÁÉÍÓÚÑ])$/u;
const FUNCTION_WORDS = new Set([
    "de",
    "del",
    "la",
    "las",
    "el",
    "los",
    "y",
    "e",
    "o",
    "u",
    "en",
    "con",
    "por",
    "para",
    "un",
    "una",
    "sobre",
    "entre",
    "sin",
    "a",
    "al",
]);

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Whether the position starts a sentence: after nothing, a line break or a sentence end */
function sentenceStart(text: string, pos: number): boolean {
    const before = text.slice(0, pos).replace(/[\s«“"‘(¿¡—-]+$/u, "");
    return !before || /[.!?:\n…]$/.test(before) || /\n\s*$/.test(text.slice(0, pos));
}

/**
 * The previous word before a position, skipping articles and prepositions.
 * Empty if that word starts the sentence, as its capital then says nothing.
 */
function previousContentWord(text: string, pos: number): string {
    const words = [...text.slice(0, pos).matchAll(/\p{L}+/gu)];
    for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i];
        const lower = word[0].toLowerCase();
        // Part of the same date: «el Lunes 3 de Enero»
        if (FUNCTION_WORDS.has(lower) || MONTHS.includes(lower) || DAYS.includes(lower)) continue;
        return sentenceStart(text, word.index) ? "" : word[0];
    }
    return "";
}

const rules: Rule[] = [
    // «No te vayas.» → «No te vayas».   (Supongo que sí.) → (Supongo que sí).
    text => {
        const found: RuleMatch[] = [];
        for (const m of text.matchAll(/([^\s.])\.([»”’"')\]])(?=\s|$)/gu)) {
            const dot = m.index + m[1].length;
            if (ABBREVIATIONS.test(text.slice(0, dot))) continue;
            found.push({
                ruleId: "RAE_PUNTO_TRAS_CIERRE",
                categoryId: "PUNCTUATION",
                from: dot,
                to: dot + 2,
                title: "Punto fuera del signo de cierre",
                message:
                    "El punto va detrás de las comillas, los paréntesis y las rayas de cierre, no delante.",
                replacements: [m[2] + "."],
            });
        }
        return found;
    },
    // ¿Vienes?. → ¿Vienes?
    text =>
        [...text.matchAll(/([?!])\.(?!\.)/g)].map(m => ({
            ruleId: "RAE_PUNTO_TRAS_INTERROGACION",
            categoryId: "PUNCTUATION",
            from: m.index,
            to: m.index + 2,
            title: "Punto tras interrogación o exclamación",
            message:
                "Tras los signos de cierre de interrogación y exclamación no se escribe punto.",
            replacements: [m[1]],
        })),
    // Estimados vecinos, → Estimados vecinos:
    text => {
        const m = /^(\s*(?:estimad|querid|apreciad|distinguid)[oa]s?\b[^\n,.:;]{0,60}),\s*$/iu.exec(
            text,
        );
        if (!m) return [];
        const comma = m[1].length;
        return [
            {
                ruleId: "RAE_SALUDO_CARTA",
                categoryId: "PUNCTUATION",
                from: comma,
                to: comma + 1,
                title: "Dos puntos tras el saludo",
                message:
                    "Tras el saludo de una carta, en línea aparte, van dos puntos, nunca coma.",
                replacements: [":"],
            },
        ];
    },
    // La subasta — la mayor del año — cerró → La subasta —la mayor del año— cerró
    text => {
        const found: RuleMatch[] = [];
        // In dialogue, «—Bien —contestó Juan—» correctly has a space before the narrator's dash
        if (text.trimStart().startsWith("—")) return [];
        for (const m of text.matchAll(
            /(^|\s)—([ \t]+)([^—\n]*?[^\s—])([ \t]*)—(?=[\s.,;:)»”]|$)/gu,
        )) {
            const from = m.index + m[1].length;
            const to = m.index + m[0].length;
            found.push({
                ruleId: "RAE_RAYA_PEGADA",
                categoryId: "TYPOGRAPHY",
                from,
                to,
                title: "Espacios dentro de las rayas",
                message:
                    "La raya de inciso va pegada a la primera y a la última palabra del inciso, y separada por un espacio de lo que queda fuera.",
                replacements: [`—${m[3]}—`],
            });
        }
        return found;
    },
    // 1998–2012 → 1998-2012
    text =>
        [...text.matchAll(/(\d+)[ \t]?–[ \t]?(\d+)/g)].map(m => ({
            ruleId: "RAE_GUION_INTERVALO",
            categoryId: "TYPOGRAPHY",
            from: m.index,
            to: m.index + m[0].length,
            title: "Guion en los intervalos",
            message:
                "Los intervalos se escriben con guion, sin espacios. La semirraya es de la tipografía inglesa.",
            replacements: [`${m[1]}-${m[2]}`],
        })),
    // 1,250,000 / 1.250.000 → 1 250 000
    text => {
        const found: RuleMatch[] = [];
        for (const m of text.matchAll(
            /(?:^|[^\d.,])(\d{1,3}(?:([.,])\d{3})(?:\2\d{3})+)(?![\d.,]\d)/g,
        )) {
            const number = m[1];
            const from = m.index + m[0].length - number.length;
            found.push({
                ruleId: "RAE_SEPARADOR_MILLARES",
                categoryId: "TYPOGRAPHY",
                from,
                to: from + number.length,
                title: "Separador de millares",
                message:
                    "Los millares se separan con un espacio fino, no con punto ni con coma, y solo en cifras de más de cuatro dígitos.",
                replacements: [number.split(m[2]).join(THIN_SPACE)],
            });
        }
        return found;
    },
    // 40% → 40 %
    text =>
        [...text.matchAll(/(\d+)%/g)].map(m => ({
            ruleId: "RAE_PORCENTAJE",
            categoryId: "TYPOGRAPHY",
            from: m.index,
            to: m.index + m[0].length,
            title: "Espacio ante el signo de porcentaje",
            message: "El signo de porcentaje va separado de la cifra por un espacio.",
            replacements: [`${m[1]}${THIN_SPACE}%`],
        })),
    // Octubre 30, 2020 → 30 de octubre de 2020
    text => {
        const months = MONTHS.join("|");
        const pattern = new RegExp(`(^|[^\\p{L}])(${months}) (\\d{1,2}),? (\\d{4})(?!\\d)`, "giu");
        return [...text.matchAll(pattern)].map(m => {
            const from = m.index + m[1].length;
            const month = m[2].toLowerCase();
            const date = `${m[3]} de ${month} de ${m[4]}`;
            return {
                ruleId: "RAE_FECHA",
                categoryId: "TYPOGRAPHY",
                from,
                to: m.index + m[0].length,
                title: "Fecha a la inglesa",
                message:
                    "En español, la fecha va en el orden día, mes y año, unidos por «de», y el mes en minúscula.",
                replacements: [sentenceStart(text, from) ? upperFirst(date) : date],
            };
        });
    },
    // el Lunes 3 de Enero → el lunes 3 de enero
    text => {
        const found: RuleMatch[] = [];
        for (const m of text.matchAll(/\p{Lu}\p{Ll}+/gu)) {
            const word = m[0];
            const lower = word.toLowerCase();
            if (sentenceStart(text, m.index)) continue;
            const before = text.slice(Math.max(0, m.index - 30), m.index);
            const after = text.slice(m.index + word.length, m.index + word.length + 12);
            // Only in a date, as months and days are also names: «con Abril», «Viernes Santo»
            const isMonth =
                MONTHS.includes(lower) &&
                (/\d\s+de\s+$/.test(before) ||
                    /^\s+(de|del)\s+\d{3,4}/.test(after) ||
                    /(^|[^\p{L}])(en|desde|hasta|durante|entre|mes de|mediados de|principios de|finales de|fines de)\s+$/iu.test(
                        before,
                    ));
            const isDay =
                DAYS.includes(lower) &&
                (/^\s+\d/.test(after) ||
                    /(^|[^\p{L}])(el|los|este|cada|próximo|pasado|un|del|al|hasta el|desde el)\s+$/iu.test(
                        before,
                    ));
            if (!isMonth && !isDay) continue;
            // «Octubre 30, 2020» is rewritten as a whole by the date rule
            if (/^\s+\d{1,2},?\s+\d{4}/.test(after)) continue;
            // Part of a proper name: «Movimiento 2 de Junio», «Julio César», «Miércoles de Ceniza»
            const previous = previousContentWord(text, m.index);
            if (previous && isUpper(previous[0])) continue;
            if (/^\s+(?:de\s+|del\s+)?\p{Lu}/u.test(after)) continue;
            found.push({
                ruleId: "RAE_MES_DIA_MINUSCULA",
                categoryId: "CASING",
                from: m.index,
                to: m.index + word.length,
                title: "Mayúscula en día o mes",
                message: "Los días de la semana y los meses se escriben con minúscula.",
                replacements: [word.toLowerCase()],
            });
        }
        return found;
    },
    // el Rey Felipe, el Papa Francisco → el rey Felipe, el papa Francisco
    text => {
        const titles = TITLES.join("|");
        const pattern = new RegExp(
            `(^|[^\\p{L}])(el|la|los|las|del|al) (${titles})(?![\\p{L}])`,
            "giu",
        );
        const found: RuleMatch[] = [];
        for (const m of text.matchAll(pattern)) {
            const title = m[3];
            if (!isUpper(title[0]) || isUpper(m[2][0])) continue;
            const from = m.index + m[1].length + m[2].length + 1;
            found.push({
                ruleId: "RAE_CARGO_MINUSCULA",
                categoryId: "CASING",
                from,
                to: from + title.length,
                title: "Mayúscula en cargo o título",
                message:
                    "Los cargos, títulos y dignidades se escriben con minúscula, también cuando acompañan al nombre: «el rey Felipe», «el papa Francisco».",
                replacements: [title.toLowerCase()],
            });
        }
        return found;
    },
    // ## Historia Y Desarrollo De La Ciudad → only the first word and proper names
    (text, { headings }) => {
        const found: RuleMatch[] = [];
        for (const heading of headings) {
            const words = [...text.slice(heading.from, heading.to).matchAll(/\p{L}+/gu)];
            if (words.length < 3) continue;
            const rest = words.slice(1);
            const capitalisedFunction = rest.filter(
                w => FUNCTION_WORDS.has(w[0].toLowerCase()) && isUpper(w[0][0]),
            );
            const capitalised = rest.filter(w => isUpper(w[0][0]) && w[0] !== w[0].toUpperCase());
            if (!capitalisedFunction.length || capitalised.length < 2) continue;
            const from = heading.from + words[0].index;
            const last = words[words.length - 1];
            const to = heading.from + last.index + last[0].length;
            found.push({
                ruleId: "RAE_TITULO_MAYUSCULAS",
                categoryId: "CASING",
                from,
                to,
                title: "Mayúsculas en el título",
                message:
                    "En español, los títulos solo llevan mayúscula en la primera palabra y en los nombres propios.",
                // Function words are never proper names, so they can be lowered safely
                replacements: [
                    text
                        .slice(from, to)
                        .replace(/\p{L}+/gu, (w, offset: number) =>
                            offset > 0 && FUNCTION_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w,
                        ),
                ],
            });
        }
        return found;
    },
    // “cita” / "cita" → «cita»
    text => {
        const found: RuleMatch[] = [];
        let depth = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === "«") depth++;
            else if (ch === "»") depth = Math.max(0, depth - 1);
            if (depth > 0) continue;
            const open = ch === "“" || (ch === '"' && (i === 0 || /[\s([—¿¡]/u.test(text[i - 1])));
            if (!open) continue;
            const close = text.indexOf(ch === "“" ? "”" : '"', i + 1);
            if (close < 0 || text.slice(i + 1, close).includes("\n")) continue;
            const inner = text.slice(i + 1, close);
            if (!inner.trim() || /[«»]/.test(inner)) continue;
            found.push({
                ruleId: "RAE_COMILLAS_ANGULARES",
                categoryId: "STYLE",
                from: i,
                to: close + 1,
                title: "Comillas angulares",
                message:
                    "En español se usan primero las comillas angulares (« »); las inglesas (“ ”) van dentro de ellas, y las simples (‘ ’) en último lugar.",
                replacements: [`«${inner}»`],
            });
            i = close;
        }
        return found;
    },
];

/** Apply the rules to text in Spanish */
export function spanishRules(text: string, context: Context): RuleMatch[] {
    return rules.flatMap(rule => rule(text, context)).sort((a, b) => a.from - b.from);
}
