/**
 * Phrases and constructions that the Libro de estilo and the Diccionario panhispánico de
 * dudas correct, and LanguageTool does not: «abordo de», «en aras a», «volví en sí»,
 * «onceavo aniversario», «Nadie no vino», «Si tendría dinero», «La dije que viniera»…
 * Each pattern starts with a group for the context before the phrase, which is not reported.
 */

import { caseLike, Rule, RuleMatch } from "./common";

interface Phrase {
    ruleId: string;
    categoryId: string;
    title: string;
    message: string;
    pattern: RegExp;
    /// The reported part of the match, as offsets in it, and its replacements; null to skip
    fix: (m: RegExpExecArray) => { from: number; to: number; replacements: string[] } | null;
}

/// The whole match after the context group
const whole = (m: RegExpExecArray, replacements: string[]) => ({
    from: m[1].length,
    to: m[0].length,
    replacements: replacements.map(r => caseLike(r, m[0].slice(m[1].length))),
});
/// The last `length` characters of the match
const last = (m: RegExpExecArray, length: number, replacements: string[]) => ({
    from: m[0].length - length,
    to: m[0].length,
    replacements,
});

const B = "(^|[^\\p{L}])";
const E = "(?![\\p{L}])";
const re = (source: string, flags = "giu") => new RegExp(source, flags);

// volver en sí, dar de sí: the pronoun follows the person
const PERSON: [string, string[]][] = [
    [
        "volví vuelvo volvía volveré volvería he_vuelto había_vuelto hube_vuelto doy di daba daré daría",
        ["mí"],
    ],
    [
        "volviste vuelves volvías volverás volverías has_vuelto habías_vuelto das diste dabas darás darías",
        ["ti"],
    ],
    [
        "volvimos volvemos volvíamos volveremos volveríamos hemos_vuelto habíamos_vuelto damos dimos dábamos daremos",
        ["nosotros", "nosotras"],
    ],
    [
        "volvisteis volvéis volvíais volveréis habéis_vuelto habíais_vuelto dais disteis dabais daréis",
        ["vosotros", "vosotras"],
    ],
];
const PRONOUN_OF = new Map<string, string[]>(
    PERSON.flatMap(([verbs, pronoun]) =>
        verbs.split(" ").map(v => [v.replace("_", " "), pronoun] as [string, string[]]),
    ),
);

// Partitives used as ordinals: «el onceavo aniversario» → «el undécimo aniversario»
const ORDINAL: Record<string, string> = {
    onceav: "undécim",
    doceav: "duodécim",
    treceav: "decimoterc",
    catorceav: "decimocuart",
    quinceav: "decimoquint",
    dieciseisav: "decimosext",
    dieciséisav: "decimosext",
    diecisieteav: "decimoséptim",
    dieciochoav: "decimoctav",
    diecinueveav: "decimonoven",
    veinteav: "vigésim",
};
const PARTITIVE = Object.keys(ORDINAL).join("|");
function ordinal(stem: string, ending: string, beforeNoun: boolean): string {
    const base = ORDINAL[stem.toLowerCase()];
    // «decimotercer piso», as «tercer piso»
    if (base === "decimoterc")
        return ending === "o" && beforeNoun
            ? "decimotercer"
            : `decimoterc${ending.replace(/^([oa])/, "er$1")}`;
    return base + ending;
}

// Coordinated articles: «los y las representantes»
const PAIRS: Record<string, string> = {
    los: "las",
    unos: "unas",
    estos: "estas",
    esos: "esas",
    aquellos: "aquellas",
};
function genders(noun: string): { masculine: string; feminine: string } {
    if (/oras$/u.test(noun)) return { masculine: noun.slice(0, -2) + "es", feminine: noun };
    if (/ores$/u.test(noun)) return { masculine: noun, feminine: noun.slice(0, -2) + "as" };
    if (/as$/u.test(noun)) return { masculine: noun.slice(0, -2) + "os", feminine: noun };
    if (/os$/u.test(noun)) return { masculine: noun, feminine: noun.slice(0, -2) + "as" };
    return { masculine: noun, feminine: noun };
}

// «Se buscan a los culpables» → «Se busca a los culpables»
const IMPERSONAL = `buscar contratar entrevistar arrestar premiar castigar investigar evacuar rescatar
invitar convocar homenajear vacunar multar juzgar condenar nombrar citar interrogar seleccionar
reclutar capturar liberar expulsar sancionar identificar localizar examinar evaluar felicitar operar`;
const SINGULAR = new Map<string, string>([
    ...IMPERSONAL.split(/\s+/).flatMap(infinitive => {
        const s = infinitive.slice(0, -2);
        return [
            [s + "an", s + "a"],
            [s + "aron", s + "ó"],
            [s + "aban", s + "aba"],
            [s + "arán", s + "ará"],
            [s + "arían", s + "aría"],
        ] as [string, string][];
    }),
    ...[
        "detienen detiene detuvieron detuvo detenían detenía detendrán detendrá",
        "atienden atiende atendieron atendió atendían atendía atenderán atenderá",
        "despiden despide despidieron despidió despedían despedía despedirán despedirá",
        "eligen elige eligieron eligió elegían elegía elegirán elegirá",
        "reciben recibe recibieron recibió recibían recibía recibirán recibirá",
    ].flatMap(forms => {
        const w = forms.split(" ");
        return [0, 2, 4, 6].map(i => [w[i], w[i + 1]] as [string, string]);
    }),
]);
const PEOPLE =
    "los|las|unos|unas|varios|varias|muchos|muchas|todos|todas|cientos|miles|decenas|\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|vecinos|personas|ciudadanos|trabajadores|empleados|alumnos|estudiantes|pacientes|candidatos|sospechosos|testigos|culpables|responsables|heridos|expertos";

// «Si tendría dinero» → «Si tuviera dinero»
const SUBJUNCTIVE: Record<string, string> = {
    tendr: "tuvie",
    habr: "hubie",
    ser: "fue",
    estar: "estuvie",
    har: "hicie",
    podr: "pudie",
    dir: "dije",
    querr: "quisie",
    sabr: "supie",
    saldr: "salie",
    vendr: "vinie",
    pondr: "pusie",
    valdr: "valie",
    cabr: "cupie",
    dar: "die",
    ir: "fue",
    ver: "vie",
    andar: "anduvie",
    mantendr: "mantuvie",
    obtendr: "obtuvie",
    detendr: "detuvie",
    sostendr: "sostuvie",
    propondr: "propusie",
    supondr: "supusie",
    dispondr: "dispusie",
    convendr: "convinie",
    traer: "traje",
    leer: "leye",
    creer: "creye",
    caer: "caye",
    oir: "oye",
};
const ENDINGS: Record<string, string> = {
    ía: "ra",
    ías: "ras",
    íamos: "ramos",
    íais: "rais",
    ían: "ran",
};
const accentLast = (s: string) =>
    s.replace(
        /([aeiou])([^aeiou]*)$/u,
        (_, v: string, rest: string) => "áéíóú"["aeiou".indexOf(v)] + rest,
    );
/** The imperfect subjunctive for a conditional, if it is surely known: «tendría» → «tuviera» */
function subjunctive(conditional: string): string | null {
    const m = /^(\p{L}+)(ía|ías|íamos|íais|ían)$/u.exec(conditional);
    if (!m) return null;
    const [, stem, ending] = m;
    let base = SUBJUNCTIVE[stem];
    if (!base) {
        if (stem.endsWith("ar")) base = stem.slice(0, -2) + "a";
        // -er verbs are regular unless their stem ends in a vowel (leer, caer)
        else if (/[^aeo]er$/u.test(stem)) base = stem.slice(0, -2) + "ie";
        // -ir verbs change their stem's e or o (pedir → pidiera), unless it is a, i or u
        else if (/[aiu][^aeiou]*ir$/u.test(stem) && !/(uir|ducir)$/u.test(stem))
            base = stem.slice(0, -2) + "ie";
        else return null;
    }
    const subjunctiveEnding = ENDINGS[ending];
    return ending === "íamos" ? accentLast(base) + subjunctiveEnding : base + subjunctiveEnding;
}
const CONDITIONAL_STEM = new RegExp(
    `^(?:${Object.keys(SUBJUNCTIVE).join("|")}|\\p{L}+(?:ar|er|ir))$`,
    "u",
);
/// Imperfects that look like conditionals: «quería», «prefería», «sugería», «adquiría»
const IMPERFECT_STEM = /(?:quer|fer|suger|diger|inger|her|quir|adher)$/u;

// «¡Sentaros!» → «¡Sentaos!»
const PRONOMINAL = `sentar callar marchar levantar acostar calmar tranquilizar preparar quedar
lavar duchar apartar acercar alejar fijar cuidar portar apuntar despertar olvidar preocupar largar
esconder comer beber poner mover meter estar venir vestir dormir reír divertir subir unir sentir
dar mirar`;

const DICENDI_PAST =
    "dije|dijo|dijimos|dijisteis|dijeron|dijiste|decía|decían|pedí|pidió|pidieron|pedía|pedían|pregunté|preguntó|preguntaron|preguntaba|conté|contó|contaron|expliqué|explicó|explicaron|ordené|ordenó|ordenaron|mandé|mandó|mandaron|rogué|rogó|rogaron|supliqué|suplicó|aconsejé|aconsejó|recomendé|recomendó|prohibí|prohibió|prohibieron|grité|gritó|gritaron|respondí|respondió|contesté|contestó|exigí|exigió|recordé|recordó|sugerí|sugirió|comenté|comentó";
/// First and second persons only: after «la da», «las dieron», the noun may be the subject
/// of a fronted object, as in «Las respuestas las da el maestro»
const DAR = "di|dimos|disteis|diste|doy|das|damos|dais|daré|darás|daremos";

const PHRASES: Phrase[] = [
    {
        ruleId: "RAE_A_BORDO",
        categoryId: "TYPOS",
        title: "«A bordo», en dos palabras",
        message:
            "«A bordo» (‘en una embarcación u otro vehículo’) se escribe en dos palabras; «abordo» es el sustantivo, sinónimo de «abordaje»: «el abordo de los piratas».",
        pattern: re(
            `${B}((?:el|un|del|al|este|ese|aquel|su|cada)[ \\t]+)?abordo(?=[ \\t]+del?${E})`,
        ),
        fix: m => (m[2] ? null : whole(m, ["a bordo"])),
    },
    {
        ruleId: "RAE_A_BORDO",
        categoryId: "TYPOS",
        title: "«A bordo», en dos palabras",
        message: "La expresión es «segundo de a bordo», con «a bordo» en dos palabras.",
        pattern: re(`${B}de[ \\t]+abordo${E}`),
        fix: m => whole(m, ["de a bordo"]),
    },
    {
        ruleId: "RAE_EN_ARAS_DE",
        categoryId: "GRAMMAR",
        title: "«En aras de»",
        message:
            "La locución es «en aras de» (‘en favor de’): «aras» va en plural y le sigue «de», nunca «a» ni «para».",
        pattern: re(`${B}en[ \\t]+(?:aras[ \\t]+(?:a|para)|ara[ \\t]+(?:a|de))${E}`),
        fix: m => whole(m, ["en aras de"]),
    },
    {
        ruleId: "RAE_ENFRENTE",
        categoryId: "STYLE",
        title: "«Enfrente», en una palabra",
        message: "Se prefiere la grafía en una palabra: «enfrente de la casa».",
        pattern: re(`${B}en[ \\t]+frente(?=[ \\t]+(?:de|del|a|al)${E})`),
        fix: m => whole(m, ["enfrente"]),
    },
    {
        ruleId: "RAE_EN_SI",
        categoryId: "GRAMMAR",
        title: "El pronombre de «volver en sí»",
        message:
            "En «volver en sí» y «dar de sí», el pronombre cambia con la persona: «volví en mí», «volviste en ti», «volvimos en nosotros», «no doy más de mí».",
        pattern: re(
            `${B}(${[...PRONOUN_OF.keys()].map(v => v.replace(" ", "[ \\t]+")).join("|")})[ \\t]+(?:más[ \\t]+)?(?:en|de)[ \\t]+sí${E}`,
        ),
        fix: m => {
            const pronoun = PRONOUN_OF.get(m[2].toLowerCase().replace(/[ \t]+/g, " "));
            return pronoun ? last(m, 2, pronoun) : null;
        },
    },
    {
        ruleId: "RAE_NO_SIENDO_QUE",
        categoryId: "STYLE",
        title: "«No siendo que»",
        message:
            "«No siendo que» carece de prestigio en la lengua culta; se dice «no sea que» o «no vaya a ser que».",
        pattern: re(`${B}no[ \\t]+siendo[ \\t]+que${E}`),
        fix: m => whole(m, ["no sea que", "no vaya a ser que"]),
    },
    {
        ruleId: "RAE_ORDINAL_PARTITIVO",
        categoryId: "GRAMMAR",
        title: "Partitivo por ordinal",
        message:
            "«Onceavo», «doceavo»… son partitivos (‘cada una de las once partes’). Para el orden se usan los ordinales: «el undécimo aniversario», «la duodécima edición».",
        pattern: re(
            `${B}((?:el|la|los|las|su|sus|del|al|este|esta|estos|estas|ese|esa|aquel|aquella|nuestro|nuestra|mi|tu)[ \\t]+)(${PARTITIVE})(o|a|os|as)(?:(?=[ \\t]+(\\p{L}+))|${E})`,
        ),
        fix: m => {
            const next = m[5]?.toLowerCase();
            if (next === "parte" || next === "partes") return null;
            const word = m[3] + m[4];
            return {
                from: m[1].length + m[2].length,
                to: m[1].length + m[2].length + word.length,
                replacements: [caseLike(ordinal(m[3], m[4], next !== undefined), word)],
            };
        },
    },
    {
        ruleId: "RAE_ORDINAL_PARTITIVO",
        categoryId: "GRAMMAR",
        title: "Partitivo por ordinal",
        message:
            "«Onceavo», «doceavo»… son partitivos. Para el orden se usan los ordinales: «el puesto decimoquinto».",
        pattern: re(
            `${B}(?:puesto|lugar|piso|planta|aniversario|edición|congreso|festival|capítulo|curso|grado|día|año)[ \\t]+(${PARTITIVE})(o|a|os|as)${E}`,
        ),
        fix: m => {
            const word = m[2] + m[3];
            return last(m, word.length, [caseLike(ordinal(m[2], m[3], false), word)]);
        },
    },
    {
        ruleId: "RAE_ARTICULOS_COORDINADOS",
        categoryId: "STYLE",
        title: "Artículos coordinados",
        message:
            "No se coordinan dos artículos ante un solo nombre. Basta el masculino genérico («los representantes»); si se quiere desdoblar, se repite el nombre: «los representantes y las representantes».",
        pattern: re(
            `${B}(los|unos|estos|esos|aquellos|las|unas|estas|esas|aquellas)[ \\t]+y[ \\t]+(los|unos|estos|esos|aquellos|las|unas|estas|esas|aquellas)[ \\t]+(\\p{L}+)${E}`,
        ),
        fix: m => {
            const [first, second, noun] = [m[2], m[3], m[4]];
            const masculineFirst = first.toLowerCase() in PAIRS;
            const masculine = masculineFirst ? first.toLowerCase() : second.toLowerCase();
            const feminine = masculineFirst ? second.toLowerCase() : first.toLowerCase();
            if (PAIRS[masculine] !== feminine || /^(de|del|que|a|en)$/iu.test(noun)) return null;
            const { masculine: him, feminine: her } = genders(noun.toLowerCase());
            const split = masculineFirst
                ? `${masculine} ${him} y ${feminine} ${her}`
                : `${feminine} ${her} y ${masculine} ${him}`;
            return whole(m, [`${masculine} ${him}`, split]);
        },
    },
    {
        ruleId: "RAE_PREPOSICION_PRONOMBRE",
        categoryId: "GRAMMAR",
        title: "«Para ti», «sin mí»",
        message:
            "Tras preposición se usan «mí» y «ti» («para ti», «sin mí»), y con «con», «conmigo» y «contigo». Se dice, en cambio, «entre tú y yo», «según tú».",
        // Not «de»: «tratar de tú», «hablarse de tú a tú»
        pattern: re(
            `${B}(a|ante|bajo|contra|desde|en|hacia|para|por|sin|sobre|tras|con)[ \\t]+(tú|yo)(?=[ \\t]*(?:[.,;:!?»”)…\\n]|$)|[ \\t]+(?:y|e|o|u|ni|también|tampoco|solo|sola|mismo|misma)${E})`,
        ),
        fix: m => {
            const preposition = m[2].toLowerCase();
            const you = m[3].toLowerCase() === "tú";
            // «de tú a tú»
            if (you && /tú[ \t]+$/iu.test(m.input.slice(0, m.index + m[1].length))) return null;
            if (preposition === "con") return whole(m, [you ? "contigo" : "conmigo"]);
            return whole(m, [`${m[2]} ${you ? "ti" : "mí"}`]);
        },
    },
    {
        ruleId: "RAE_DOBLE_NEGACION",
        categoryId: "GRAMMAR",
        title: "Negación doble",
        message:
            "Cuando «nadie», «nunca», «tampoco» o «ninguno» van delante del verbo, no se combinan con «no»: «Nadie vino», «Tampoco lo hizo».",
        pattern: re(
            `(^|[.?!…][ \\t]+|[¿¡—\\n])(nadie|nunca|tampoco|jamás|ninguno|ninguna)[ \\t]+no(?=[ \\t]+\\p{L})`,
        ),
        fix: m => ({ from: m[1].length, to: m[0].length, replacements: [m[2]] }),
    },
    {
        ruleId: "RAE_SE_IMPERSONAL",
        categoryId: "GRAMMAR",
        title: "«Se busca a…», en singular",
        message:
            "Cuando el complemento lleva «a», la construcción con «se» es impersonal y el verbo va en singular: «Se busca a los culpables», «Se contrató a varios expertos».",
        pattern: re(`${B}se[ \\t]+(\\p{L}+)(?=[ \\t]+a[ \\t]+(?:${PEOPLE})${E})`),
        fix: m => {
            const singular = SINGULAR.get(m[2].toLowerCase());
            return singular ? last(m, m[2].length, [caseLike(singular, m[2])]) : null;
        },
    },
    {
        ruleId: "RAE_SI_CONDICIONAL",
        categoryId: "GRAMMAR",
        title: "Condicional tras «si»",
        message:
            "Tras el «si» de una condición va el imperfecto de subjuntivo, no el condicional: «Si tuviera dinero, viajaría»; «Si lo hubiera sabido, te lo habría dicho».",
        pattern: re(
            `(^|[.?!…][ \\t]+|\\n|—)Si[ \\t]+((?:(?:yo|tú|él|ella|usted|nosotros|nosotras|vosotros|vosotras|ellos|ellas|ustedes|no|ya|lo|la|le|los|las|les|me|te|se|nos|os|nunca|también|tampoco|todavía|aún)[ \\t]+){0,3})(\\p{Ll}+(?:ía|ías|íamos|íais|ían))${E}`,
            "gu",
        ),
        fix: m => {
            const verb = m[3];
            const stem = verb.replace(/(ía|ías|íamos|íais|ían)$/u, "");
            if (!/r$/u.test(stem) || !CONDITIONAL_STEM.test(stem)) return null;
            if (!(stem in SUBJUNCTIVE) && IMPERFECT_STEM.test(stem)) return null;
            // «Si la librería…»: an article and a noun in -ería
            if (/(?:^|\s)(?:la|las|los)\s+$/u.test(m[2]) && /ería|erías$/u.test(verb)) return null;
            const fixed = subjunctive(verb);
            return last(m, verb.length, fixed ? [fixed] : []);
        },
    },
    {
        ruleId: "RAE_LAISMO",
        categoryId: "GRAMMAR",
        title: "Laísmo o loísmo",
        message:
            "Con «decir», «pedir», «preguntar»… la persona es el complemento indirecto: «le» o «les», no «la», «las» ni «los»: «Le dije que viniera».",
        pattern: re(
            `${B}((?:me|te|se|nos|os)[ \\t]+)?(la|las|los)(?=[ \\t]+(?:${DICENDI_PAST})[ \\t]+que${E})`,
        ),
        fix: m =>
            m[2]
                ? null
                : last(m, m[3].length, [
                      caseLike(m[3].toLowerCase() === "la" ? "le" : "les", m[3]),
                  ]),
    },
    {
        ruleId: "RAE_LAISMO",
        categoryId: "GRAMMAR",
        title: "Laísmo o loísmo",
        message:
            "Con «dar», la persona que recibe es el complemento indirecto: «le» o «les», no «la», «las» ni «los»: «Le di un beso».",
        pattern: re(
            `${B}((?:me|te|se|nos|os)[ \\t]+)?(la|las|los)(?=[ \\t]+(?:${DAR})[ \\t]+(?:un|una|unos|unas|el|la|los|las|mi|tu|su|sus)${E})`,
        ),
        fix: m =>
            m[2]
                ? null
                : last(m, m[3].length, [
                      caseLike(m[3].toLowerCase() === "la" ? "le" : "les", m[3]),
                  ]),
    },
    {
        ruleId: "RAE_DEQUEISMO",
        categoryId: "GRAMMAR",
        title: "Dequeísmo",
        message:
            "Cuando la oración con «que» es el sujeto, no lleva «de»: «Es importante que lo sepas».",
        pattern: re(
            `${B}(?:es|era|fue|será|sería|resulta|resultaba|parece|parecía)[ \\t]+(?:(?:muy|más|tan|poco|bastante|realmente)[ \\t]+)?(?:importante|necesario|necesaria|probable|obvio|evidente|cierto|lógico|normal|conveniente|preciso|imposible|fundamental|esencial|urgente|mejor|bueno|malo|fácil|difícil|increíble|natural|raro|extraño|justo|curioso|triste|lamentable|indispensable|imprescindible|vital|claro|seguro|verdad|mentira|una[ \\t]+pena|una[ \\t]+lástima)[ \\t]+de[ \\t]+que${E}`,
        ),
        fix: m => last(m, m[0].length - m[0].search(/de[ \t]+que$/u), ["que"]),
    },
    {
        ruleId: "RAE_QUEISMO",
        categoryId: "GRAMMAR",
        title: "Queísmo",
        message:
            "Este verbo o nombre lleva «de»: «me olvidé de que», «te acuerdas de que», «con la condición de que», «no cabe duda de que», «tengo la sensación de que».",
        pattern: re(
            `${B}(?:(?:me|te|se|nos|os)[ \\t]+olvid\\p{L}*|(?:me|te|nos|os)[ \\t]+(?:acuerd|acord)\\p{L}*|(?:con|a)[ \\t]+(?:la[ \\t]+)?condición|(?:cabe|cabía|cupo|hay|había|hubo|habrá|queda|quedaba)[ \\t]+(?:(?:ninguna|ni|la[ \\t]+menor)[ \\t]+)?duda|(?:tengo|tienes|tiene|tenemos|tenéis|tienen|tenía|tenías|teníamos|tenían|tuve|tuviste|tuvo|tuvimos|tuvieron)[ \\t]+la[ \\t]+(?:sensación|impresión|certeza|seguridad|sospecha))[ \\t]+que${E}`,
        ),
        fix: m => last(m, 3, ["de que"]),
    },
    {
        ruleId: "RAE_IMPERATIVO_OS",
        categoryId: "GRAMMAR",
        title: "Imperativo con «os»",
        message:
            "El imperativo de «vosotros» con «os» pierde la «d»: «sentaos», «callaos», «poneos», «veníos»; no «sentaros». Solo con «ir» se admite «iros».",
        pattern: re(
            `(^|[.?!…][ \\t]+|[¡¿—\\n])(${PRONOMINAL.split(/\s+/)
                .map(v => v.slice(0, -2) + `(?:${v.slice(-2).replace("í", "[ií]")})`)
                .join("|")})os${E}`,
        ),
        fix: m => {
            const verb = m[2];
            const stem = verb.slice(0, -2);
            const vowel = verb.slice(-2, -1).toLowerCase();
            return {
                from: m[1].length,
                to: m[0].length,
                replacements: [stem + (vowel === "a" ? "aos" : vowel === "e" ? "eos" : "íos")],
            };
        },
    },
    {
        ruleId: "RAE_IMPERATIVO_SE",
        categoryId: "GRAMMAR",
        title: "Imperativo con «se»",
        message:
            "La «n» de «ustedes» va antes del pronombre: «váyanse», «siéntense», «quédense»; no «váyasen».",
        pattern: re(`${B}(\\p{L}*[áéíóú]\\p{L}*[aeiou])sen${E}`),
        fix: m => whole(m, [m[2].toLowerCase() + "nse"]),
    },
    {
        ruleId: "RAE_INFINITIVO_RADICAL",
        categoryId: "STYLE",
        title: "Infinitivo sin verbo",
        message:
            "Se recomienda no usar el infinitivo como verbo principal («Por último, agradecer…») y añadir un verbo conjugado: «Por último, quiero agradecer…».",
        pattern: re(
            `(^|[.?!…][ \\t]+|\\n)(?:Por último|Para terminar|Para finalizar|Para concluir|Finalmente|Antes de nada|Antes que nada|En primer lugar|En segundo lugar|Por otra parte|Por otro lado|Por mi parte|Por nuestra parte|Asimismo|Además|Para empezar|Por lo demás),[ \\t]+((?:agradecer|decir|señalar|recordar|destacar|indicar|comentar|mencionar|añadir|subrayar|informar|comunicar|felicitar|desear|invitar|animar|aclarar|explicar|resaltar|reiterar|insistir|manifestar|expresar|lamentar|pedir|rogar|solicitar|anunciar|confirmar|advertir|apuntar|precisar|matizar|puntualizar|reconocer|saludar|dar|enviar|transmitir)(?:le|les|lo|la|los|las|me|nos|se)?)${E}`,
            "gu",
        ),
        fix: m => last(m, m[2].length, [`quiero ${m[2]}`, `queremos ${m[2]}`]),
    },
];

export const phraseRules: Rule = text => {
    const found: RuleMatch[] = [];
    for (const phrase of PHRASES) {
        for (const m of text.matchAll(phrase.pattern)) {
            const fix = phrase.fix(m);
            if (!fix) continue;
            found.push({
                ruleId: phrase.ruleId,
                categoryId: phrase.categoryId,
                title: phrase.title,
                message: phrase.message,
                from: m.index + fix.from,
                to: m.index + fix.to,
                replacements: fix.replacements,
            });
        }
    }
    return found;
};
