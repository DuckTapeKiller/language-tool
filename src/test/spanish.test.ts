import { describe, expect, test } from "bun:test";
import { RuleMatch, sentenceCase, spanishRules } from "../rules/spanish";

/** The text with the first suggestion of every match applied */
const context = (text: string, heading: boolean) => ({
    headings: heading ? [{ from: 0, to: text.length }] : [],
});

function fix(text: string, heading = false): string {
    let result = text;
    for (const m of [...spanishRules(text, context(text, heading))].reverse())
        if (m.replacements.length)
            result = result.slice(0, m.from) + m.replacements[0] + result.slice(m.to);
    return result;
}
const ids = (text: string, heading = false) =>
    spanishRules(text, context(text, heading)).map((m: RuleMatch) => m.ruleId);
const NB = " ";

describe("full stop after closing signs", () => {
    test("moves the full stop out of quotation marks and brackets", () => {
        expect(fix("Me dijo: «No te vayas.»")).toBe("Me dijo: «No te vayas».");
        expect(fix("(Supongo que estaba pensando en otras cosas.)")).toBe(
            "(Supongo que estaba pensando en otras cosas).",
        );
    });
    test("leaves abbreviations and correct text alone", () => {
        expect(ids("Trajo libros, cuadernos (etc.) y más.")).toEqual([]);
        expect(ids("Me dijo: «No te vayas».")).toEqual([]);
        expect(ids("Lo firmó (J. L. González) ayer.")).toEqual([]);
    });
});

describe("full stop after question and exclamation marks", () => {
    test("removes it", () => {
        expect(fix("¿Vienes?.")).toBe("¿Vienes?");
        expect(fix("¡Qué bien!. Me alegro.")).toBe("¡Qué bien! Me alegro.");
    });
    test("leaves an ellipsis alone", () => expect(ids("¿Y entonces?...")).toEqual([]));
});

describe("letter greeting", () => {
    test("uses a colon", () => expect(fix("Estimados vecinos,")).toBe("Estimados vecinos:"));
    test("only when the greeting stands alone", () =>
        expect(ids("Estimados vecinos, les escribo para...")).toEqual([]));
});

describe("em dashes", () => {
    test("join the aside", () => {
        expect(fix("La subasta — la mayor del año — cerró en junio")).toBe(
            "La subasta —la mayor del año— cerró en junio",
        );
        expect(fix("La subasta — la mayor del año— cerró")).toBe(
            "La subasta —la mayor del año— cerró",
        );
    });
    test("correct asides and dialogue are left alone", () => {
        expect(ids("La subasta —la mayor del año— cerró en junio")).toEqual([]);
        expect(ids("—Bien —contestó Juan—. ¿Tú?")).toEqual([]);
        expect(ids("—Hola, Silvia —dijo Juan—, ¿qué tal?")).toEqual([]);
    });
});

describe("ranges", () => {
    test("use a hyphen", () =>
        expect(fix("Vivió en Bogotá (1998–2012).")).toBe("Vivió en Bogotá (1998-2012)."));
    test("hyphens are left alone", () => expect(ids("Vivió allí (1998-2012).")).toEqual([]));
    test("the whole range is underlined", () => {
        const [m] = spanishRules("pp. 181–206.", { headings: [] });
        expect("pp. 181–206.".slice(m.from, m.to)).toBe("181–206");
    });
});

describe("thousands", () => {
    test("are separated by a space", () => {
        expect(fix("Costó 1,250,000 pesos.")).toBe(`Costó 1${NB}250${NB}000 pesos.`);
        expect(fix("Costó 1.250.000 pesos.")).toBe(`Costó 1${NB}250${NB}000 pesos.`);
        expect(fix("Asistieron 20.000 personas.")).toBe(`Asistieron 20${NB}000 personas.`);
        expect(fix("Pagó 20.000,50 euros.")).toBe(`Pagó 20${NB}000,50 euros.`);
    });
    test("four digits take no separator", () => {
        expect(fix("Llegaron 1.250 soldados.")).toBe("Llegaron 1250 soldados.");
        expect(fix("Cuesta 1.000 pesos.")).toBe("Cuesta 1000 pesos.");
    });
    test("years, decimals, codes, versions and correct numbers are left alone", () => {
        expect(ids("En 1998 había 3,5 millones; el código 28004; 6.10.2017; 3,500")).toEqual([]);
        expect(ids("La versión 3.100.1 salió; 2.5 kg; 15.06 h.")).toEqual([]);
        expect(ids(`Asistieron 20${NB}000 personas y 20 000 más.`)).toEqual([]);
    });
});

describe("percentages", () => {
    test("take a space", () =>
        expect(fix("Subió un 40% este año.")).toBe(`Subió un 40${NB}% este año.`));
    test("a space is left alone", () => expect(ids("Subió un 40 % este año.")).toEqual([]));
});

describe("dates", () => {
    test("are written day, month and year", () => {
        expect(fix("Llegó el Octubre 30, 2020 por la tarde.")).toBe(
            "Llegó el 30 de octubre de 2020 por la tarde.",
        );
        expect(fix("Octubre 30, 2020 fue un viernes.")).toBe(
            "30 de octubre de 2020 fue un viernes.",
        );
    });
});

describe("months and days", () => {
    test("are lower case in dates", () => {
        expect(fix("Nos vemos el Lunes 3 de Enero.")).toBe("Nos vemos el lunes 3 de enero.");
        expect(fix("Llegó en Marzo de 1999.")).toBe("Llegó en marzo de 1999.");
    });
    test("names and proper nouns are left alone", () => {
        expect(ids("Vino con Abril y con Mayo, sus hijas.")).toEqual([]);
        expect(ids("Estalló la Revolución de Octubre.")).toEqual([]);
        expect(ids("Fue a la Plaza de Mayo.")).toEqual([]);
        expect(ids("Enero empezó con frío.")).toEqual([]);
        expect(ids("Lo bautizó Movimiento 2 de Junio.")).toEqual([]);
        expect(ids("La guerra civil entre Julio César y Pompeyo.")).toEqual([]);
        expect(ids("La Cuaresma comienza con el Miércoles de Ceniza.")).toEqual([]);
    });
});

describe("positions and titles", () => {
    test("are lower case", () =>
        expect(fix("Lo recibió el Rey Felipe y luego el Papa Francisco.")).toBe(
            "Lo recibió el rey Felipe y luego el papa Francisco.",
        ));
    test("at the start of a sentence they are left alone", () =>
        expect(ids("El Rey León es una película.")).toEqual([]));
});

describe("title case in headings", () => {
    test("is reported in headings", () => {
        expect(ids("Historia Y Desarrollo De La Ciudad", true)).toEqual(["RAE_TITULO_MAYUSCULAS"]);
        expect(fix("Cien Años De Soledad", true)).toBe("Cien años de soledad");
        expect(fix("Historia Y Desarrollo De La Ciudad", true)).toBe(
            "Historia y desarrollo de la ciudad",
        );
    });
    test("proper names and normal headings are left alone", () => {
        expect(ids("Quién fue Pedro de Heredia", true)).toEqual([]);
        expect(ids("La perla amurallada del Caribe colombiano", true)).toEqual([]);
        expect(ids("Historia Y Desarrollo De La Ciudad", false)).toEqual([]);
    });
});

describe("quotation marks", () => {
    test("angular quotation marks come first", () => {
        expect(fix("Dijo “no hay motivo” y se fue.")).toBe("Dijo «no hay motivo» y se fue.");
        expect(fix('Dijo "no hay motivo" y se fue.')).toBe("Dijo «no hay motivo» y se fue.");
    });
    test("quotation marks inside angular ones are left alone", () => {
        expect(ids("«Antonio me dijo: “Vaya ‘cacharro’ se ha comprado Julián”»")).toEqual([]);
        expect(ids("Dijo «no hay motivo» y se fue.")).toEqual([]);
    });
});

describe("the skill's correct examples", () => {
    // Taken from the editor-spanish skill: none of these may be reported
    const correct = [
        "Solo vino este",
        "Compró pan, leche y huevos",
        "Te lo iba a decir, pero no estaba seguro",
        "En el siglo XX, se vivía bien sin Internet",
        "¿Quién eres? ¿Cómo te llamas?",
        "las 15:06 h",
        "6/10/2017",
        "Madrid, 6 de octubre de 2017",
        "el 2 %",
        "Se llama José Luis —al menos que yo sepa—.",
        "…(la bibliografía existente —incluso en español— es extensa)…",
        "el lunes 3 de enero, en primavera",
        "Gracias, amigas, por esta velada",
        "Me llamo Lucía. ¿Tú?",
    ];
    for (const text of correct) test(text, () => expect(ids(text)).toEqual([]));
});

describe("sentence case", () => {
    test("lowers every word after the first", () =>
        expect(sentenceCase("Historia Y Desarrollo De La Ciudad")).toBe(
            "Historia y desarrollo de la ciudad",
        ));
    test("keeps acronyms and the words it is told are names", () => {
        expect(sentenceCase("Informe De La ONU Sobre El Clima")).toBe(
            "Informe de la ONU sobre el clima",
        );
        const title = "La Historia De Pedro De Heredia En Cartagena";
        const names = new Set(["Pedro", "Heredia", "Cartagena"]);
        expect(sentenceCase(title, w => names.has(w))).toBe(
            "La historia de Pedro de Heredia en Cartagena",
        );
    });
});
