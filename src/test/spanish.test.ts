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

describe("dialogue", () => {
    // The examples of the Libro de estilo and of Diálogos, which must not be reported
    const correct = [
        "—Hola —saludó Juan.",
        "—¿Qué tal? —dijo Silvia.",
        "—Bien —contestó Juan—. ¿Tú?",
        "—También bien —respondió Silvia—, o eso creo.",
        "—¿Qué tal? —dijo Silvia—. ¿Todo en orden?",
        "—¡Sí! —contestó Juan—. ¿Tú?",
        "—También bien… —respondió Silvia—, o eso creo.",
        "—Hola, Silvia —dijo Juan—, ¿qué tal?",
        "—Todo ha ido bien —dijo Silvia—; al menos, eso creo.",
        "—¿Estás contenta? —quiso saber Juan.",
        "—Sí —sonrió Silvia.",
        "—Hola, Silvia. —Juan se ruborizó un poco—. ¿Qué tal?",
        "—Bien. —Silvia notó que Juan se ruborizaba y dijo—: ¿Estás bien?",
        "—Sí. —Juan dijo esto tranquilizándose un poco. Y añadió—: Estoy un poco cansado.",
        "―Espero que todo salga bien ―dijo Azucena con gesto ilusionado.",
        "―Lo principal es sentirse viva ―añadió Pilar―. Afortunada o desafortunada, pero viva.",
        "―¡Qué le vamos a hacer! ―exclamó resignada doña Patro.",
        "―Está bien ―dijo Carlos―; lo haré, pero que sea la última vez que me lo pides.",
        "―No se moleste. ―Cerró la puerta y salió de mala gana.",
        "―Me voy ya. ―Se puso en pie con gesto decidido―. No hace falta que me acompañe.",
        "―¡Esto que has hecho ―gritó― es una auténtica locura!",
        "―Solo nos queda esto ―le enseñó unos pocos billetes― para el resto del viaje.",
        "―Anoche estuve en una fiesta ―me confesó, y añadió―: Conocí a personas muy interesantes.",
        "«Es imprescindible ―señaló el ministro― que se refuercen los sistemas».",
        "—¡No puedo oírte! —gritó Kismine, atenta a la escena frente a ella—. ¡Tienes que hablar más fuerte!",
        "«Hola», dijo Juan.",
        "«Hola, Silvia —dijo Juan—. ¿Qué tal?».",
        "—…",
        "—Trajo pan, leche, etc. —dijo Juan.",
        "— agudas",
        "— llanas, cuyo acento recae en la penúltima sílaba;",
    ];
    for (const text of correct) test(text, () => expect(ids(text)).toEqual([]));

    test("the dash of the character's words is a raya joined to them", () => {
        expect(fix("— Hola —dijo Juan.")).toBe("—Hola —dijo Juan.");
        expect(fix("– Hola –dijo Juan–. ¿Tú?")).toBe("—Hola —dijo Juan—. ¿Tú?");
        expect(fix("—Bien —contestó Juan —. ¿Tú?")).toBe("—Bien —contestó Juan—. ¿Tú?");
        expect(fix("—Bien — contestó Juan—. ¿Tú?")).toBe("—Bien —contestó Juan—. ¿Tú?");
    });
    test("a verb of saying takes no full stop or comma before it, and a small letter", () => {
        expect(fix("—Hola —Dijo Juan.")).toBe("—Hola —dijo Juan.");
        expect(fix("—Hola. —dijo Juan.")).toBe("—Hola —dijo Juan.");
        expect(fix("—Hola. —Dijo Juan.")).toBe("—Hola —dijo Juan.");
        expect(fix("—¿Vienes? —Preguntó Ana.")).toBe("—¿Vienes? —preguntó Ana.");
        expect(fix("—Hola, —dijo Juan—, ¿qué tal?")).toBe("—Hola —dijo Juan—, ¿qué tal?");
        expect(fix("—Hola —Se quejó Juan.")).toBe("—Hola —se quejó Juan.");
        expect(fix("—No lo sé. —Respondí.")).toBe("—No lo sé —respondí.");
        expect(fix("«Hola, —Dijo Juan—, ¿qué tal?»")).toBe("«Hola —dijo Juan—, ¿qué tal?»");
    });
    test("the full stop goes after the narrator's closing dash", () =>
        expect(fix("—Bien —contestó Juan.— ¿Tú?")).toBe("—Bien —contestó Juan—. ¿Tú?"));
});

describe("asides", () => {
    const correct = [
        "Se llama José Luis —al menos que yo sepa—.",
        "Venezuela —primer lugar de tierra firme avistado por Colón (1498)— tenía 300 000 habitantes.",
        "Me dijo convencido que lo sabía —¿sería verdad?—.",
        "¿Han venido todos —María, Antonio y Teresa—?",
        "Los rayos gamma producen alteraciones celulares —cáncer, mutaciones genéticas, etc.—.",
        "Esto es lo que quiere —según he entendido—: acelgas, puerros y berenjenas.",
        "Vinieron 2-3 personas, a 25-30 km, en clases teórico-prácticas.",
        "El cuidado pre- y posnatal; el Madrid-Barça; Rodríguez-Moñino.",
        "Madrid - Barcelona - Valencia.",
        "• Python – un lenguaje",
        "Y entonces —",
    ];
    for (const text of correct) test(text, () => expect(ids(text)).toEqual([]));

    test("hyphens and en dashes become rayas", () => {
        expect(fix("La subasta - la mayor del año - cerró ayer.")).toBe(
            "La subasta —la mayor del año— cerró ayer.",
        );
        expect(fix("La subasta – la mayor del año – cerró ayer.")).toBe(
            "La subasta —la mayor del año— cerró ayer.",
        );
    });
    test("the horizontal bar counts as a raya", () =>
        expect(fix("La subasta ― la mayor del año ― cerró.")).toBe(
            "La subasta ―la mayor del año― cerró.",
        ));
    test("rayas are separated from what is outside the aside", () =>
        expect(fix("Sabía—todos lo sabían—que vendría.")).toBe(
            "Sabía —todos lo sabían— que vendría.",
        ));
    test("an aside at the end of a sentence is closed too", () => {
        expect(fix("Se llama José Luis —al menos que yo sepa.")).toBe(
            "Se llama José Luis —al menos que yo sepa—.",
        );
        expect(fix("Llegó tarde — como siempre.")).toBe("Llegó tarde —como siempre—.");
        expect(fix("Se llama José Luis —al menos que yo sepa.—")).toBe(
            "Se llama José Luis —al menos que yo sepa—.",
        );
    });
});

describe("opening question and exclamation marks", () => {
    const correct = [
        "¿Qué hora es?",
        "¡Qué alegría!",
        "Ay, ¡qué bien!",
        "¿Que quién soy? Soy tu primo.",
        "¿Dónde estás?; no te veo.",
        "Me llamo Lucía. ¿Tú?",
        "Pero… ¿no ibas a ir?",
        "¿Podrías traerme mi ropa: la camisa, los pantalones, los zapatos, etc.?",
        "Ha hablado de paraprosexia (?) en clase.",
        "Dijo que existen ranas con pelo (!).",
        "¿Quién eres?, ¿cómo te llamas?, ¿por qué has venido?",
        "¡¡¡Bravoooo!!!",
        "¿¡Qué me estás contando!?",
        "¡Qué me estás contando?",
        "Juan, ¿vienes?",
        "Si llueve, ¿vendrás?",
        "«What is this?», preguntó.",
        "El factorial 5! vale 120.",
        "Visita https://ejemplo.com/?q=1 hoy.",
    ];
    for (const text of correct) test(text, () => expect(ids(text)).toEqual([]));

    const first = (text: string) => spanishRules(text, { headings: [] })[0]?.replacements;
    test("the opening sign is added where the question starts", () => {
        expect(fix("Qué hora es? Llego tarde.")).toBe("¿Qué hora es? Llego tarde.");
        expect(fix("Qué bien! Ya llegaste.")).toBe("¡Qué bien! Ya llegaste.");
        expect(fix("¿Quién eres?, cómo te llamas?")).toBe("¿Quién eres?, ¿cómo te llamas?");
    });
    test("what goes before the question stays outside it", () => {
        expect(first("Juan, vienes?")).toEqual(["Juan, ¿vienes", "¿Juan, vienes"]);
        expect(first("Si llueve mañana, vendrás?")?.[0]).toBe("Si llueve mañana, ¿vendrás");
        expect(first("Entonces, venís mañana?")?.[0]).toBe("Entonces, ¿venís");
        expect(first("Oye, dónde está tu casa?")?.[0]).toBe("Oye, ¿dónde");
        expect(first("Quieres pan, leche o huevos?")?.[0]).toBe("¿Quieres pan, leche");
    });
    test("question marks are not doubled", () =>
        expect(fix("¿¿Qué estás diciendo??")).toBe("¿Qué estás diciendo?"));
});

describe("headings", () => {
    test("take no full stop", () => {
        expect(fix("Historia de la ciudad.", true)).toBe("Historia de la ciudad");
        expect(ids("Historia de la ciudad.")).toEqual([]);
    });
    test("numbers, abbreviations and ellipses are left alone", () => {
        for (const heading of ["Capítulo 1. El comienzo", "Notas, etc.", "1.", "Y entonces..."])
            expect(ids(heading, true)).toEqual([]);
    });
});

describe("abbreviations", () => {
    test("take a space after each full stop", () => {
        expect(fix("Viajó a EE.UU. y a EEUU.")).toBe("Viajó a EE. UU. y a EE. UU.");
        expect(fix("Nació en el 384 a.C. en Estagira.")).toBe("Nació en el 384 a. C. en Estagira.");
        expect(fix("Murió en el siglo V d.C.")).toBe("Murió en el siglo V d. C.");
        expect(fix("Quedamos a las 10am y a las 6 p.m.")).toBe(
            "Quedamos a las 10 a. m. y a las 6 p. m.",
        );
        expect(fix("Trabaja en Telefónica S.A. desde 2010.")).toBe(
            "Trabaja en Telefónica S. A. desde 2010.",
        );
        expect(fix("Lo firmó J.L. González.")).toBe("Lo firmó J. L. González.");
        expect(fix("Lo aclara la N.del T. al pie.")).toBe("Lo aclara la N. del T. al pie.");
        expect(fix("Habló con RRHH.")).toBe("Habló con RR. HH.");
    });
    test("correct abbreviations and look-alikes are left alone", () =>
        expect(
            ids(
                "En EE. UU., en el 384 a. C., a las 10 a. m., con J. L. González y RR. HH. Llegaron 10 amigos a mediodía.",
            ),
        ).toEqual([]));
});

describe("phrases", () => {
    const cases: [string, string][] = [
        ["Había 106 inmigrantes abordo del barco.", "Había 106 inmigrantes a bordo del barco."],
        ["Es el segundo de abordo.", "Es el segundo de a bordo."],
        ["Lo hizo en aras a la paz.", "Lo hizo en aras de la paz."],
        ["Vive en frente de la iglesia.", "Vive enfrente de la iglesia."],
        [
            "Cuando volví en sí, estaba en el hospital.",
            "Cuando volví en mí, estaba en el hospital.",
        ],
        ["Ya no doy más de sí.", "Ya no doy más de mí."],
        [
            "Cierra la puerta, no siendo que entre el gato.",
            "Cierra la puerta, no sea que entre el gato.",
        ],
        ["Celebró el onceavo aniversario.", "Celebró el undécimo aniversario."],
        ["Es la doceava edición.", "Es la duodécima edición."],
        ["Vive en el treceavo piso.", "Vive en el decimotercer piso."],
        ["Llegó en el puesto quinceavo.", "Llegó en el puesto decimoquinto."],
        ["Los y las representantes votaron.", "Los representantes votaron."],
        ["Este regalo es para tú.", "Este regalo es para ti."],
        ["Vendrá con yo y con él.", "Vendrá conmigo y con él."],
        ["Nadie no vino a la fiesta.", "Nadie vino a la fiesta."],
        ["Se buscan a los culpables del robo.", "Se busca a los culpables del robo."],
        ["Se contrataron a varios expertos.", "Se contrató a varios expertos."],
        ["Si tendría dinero, viajaría.", "Si tuviera dinero, viajaría."],
        ["Si lo habría sabido, te lo habría dicho.", "Si lo hubiera sabido, te lo habría dicho."],
        ["Si estudiaríamos más, aprobaríamos.", "Si estudiáramos más, aprobaríamos."],
        ["Si comería menos, adelgazaría.", "Si comiera menos, adelgazaría."],
        ["La dije que viniera pronto.", "Le dije que viniera pronto."],
        ["Los pregunté que si querían ir.", "Les pregunté que si querían ir."],
        ["La di un beso a Manuela.", "Le di un beso a Manuela."],
        ["Es importante de que lo sepas.", "Es importante que lo sepas."],
        ["Me olvidé que era lunes.", "Me olvidé de que era lunes."],
        ["¿Te acuerdas que fuimos al cine?", "¿Te acuerdas de que fuimos al cine?"],
        ["No cabe duda que lloverá.", "No cabe duda de que lloverá."],
        [
            "Te lo presto con la condición que lo cuides.",
            "Te lo presto con la condición de que lo cuides.",
        ],
        ["Tengo la sensación que va a llover.", "Tengo la sensación de que va a llover."],
        ["¡Sentaros todos, por favor!", "¡Sentaos todos, por favor!"],
        ["¡Callaros ya!", "¡Callaos ya!"],
        ["¡Veniros conmigo!", "¡Veníos conmigo!"],
        ["Váyasen de aquí.", "Váyanse de aquí."],
        [
            "Por último, agradecer a todos su asistencia.",
            "Por último, quiero agradecer a todos su asistencia.",
        ],
    ];
    for (const [wrong, right] of cases) test(wrong, () => expect(fix(wrong)).toBe(right));

    test("coordinated articles offer the generic masculine and the split", () =>
        expect(
            spanishRules("Los y las alumnas votaron.", { headings: [] })[0].replacements,
        ).toEqual(["Los alumnos", "Los alumnos y las alumnas"]));
    test("a conditional without a sure subjunctive is reported without a fix", () => {
        const [m] = spanishRules("Si pediría ayuda, vendrían.", { headings: [] });
        expect(m.ruleId).toBe("RAE_SI_CONDICIONAL");
        expect(m.replacements).toEqual([]);
    });

    const correct = [
        "El abordo de los piratas fue rápido.",
        "Cuando volvió en sí, estaba en el hospital.",
        "Le tocó la onceava parte de la herencia.",
        "Entre tú y yo no hay secretos. Hablamos de tú a tú. Lo hizo sin yo saberlo.",
        "Si no viene nadie no pasa nada.",
        "Se dedican a los niños. Se trasladaron a Madrid.",
        "Si quería venir, podía. Si la librería abre, iré. No sé si vendría. ¿Si sería verdad?",
        "Si prefería quedarse, se quedaba.",
        "Te lo dije que no vinieras. La canción la canté yo.",
        "Ya es hora de que te vayas. Estoy seguro de que vendrá.",
        "Se acordó que la reunión sería el lunes. Olvidé que era lunes.",
        "¡Iros a casa! Quiero veros pronto.",
        "Si hablasen más, se entenderían.",
        "Por último, el informe fue aprobado.",
    ];
    for (const text of correct) test(text, () => expect(ids(text)).toEqual([]));
});

describe("false positives found in the vault", () => {
    const correct = [
        "Las respuestas también las da el maestro.",
        "¿Podemos tratarlo de tú, maestro?",
        "• Randi, James (1980). Flim-Flam! (en inglés). Prometheus Books.",
        "Se publicó como Fake! (1969). Irving y de Hory aparecen en el documental.",
        "En el juego de cartas Yu-Gi-Oh!, de Konami.",
        "«¡Las Malvinas son... italianas!»",
        "« La musique africaine : un savoir qui s’ignore ? ». In A. Sureau éd.",
        "Koch, Christof (2014). Is Consciousness Universal? Scientific American.",
        "Pellwel, Calvin E (2022). «What Is Dowsing? - The Ancient Practice».",
        "Sus obras: Cheburashka (1969-1983), Nu, pogodí! (Ну, погоди!), Erizo en la niebla.",
        "Comprende una traducción del Quid fles? de Horacio y las del O navis! por Almeida.",
        "Johnson, Victoria Stapells, ([1992?]). Los corsarios. Santo Dominuo [!] Imprenta.",
        "¿Qué cosa hay que se tenga\npor verdad lo que no es?",
        "Correcta: —¡No puedo oírte! —gritó Kismine, atenta a la escena.",
        "Respuestas con el verbo hacer (—¿Qué haces? —Comer), entre otras.",
        "• PatrimonioNacional.es — Relación de la batalla de 1571.",
        "«Adolfo Mejía - Viajero de mí mismo [Documental] - YouTube». www.youtube.com.",
        "Educação – Antropologia e Educação – Ideias, Ideais e História.",
        "Ereso, isla de Lesbos, ca. 371 a. C. – ca. 287 a. C.) fue un filósofo.",
        "En el español europeo las formas en -ra y -se suelen ser intercambiables.",
        "En algunos casos se adopta la terminación -isa o -esa: papa/papisa.",
        "Uso de la h- únicamente cuando procede de F- inicial latina.",
        "Recitado por Adolfo Marsillach — palabravirtual.com.",
        "Es vivo — no está muerto; es el primero — su existencia no se debe a ninguna causa.",
        "-En los descubrimientos: Se harían con licencia. Ni por tierra. -En las colonizaciones: Se prohibirían.",
        "-Ver parte que relata el descubrimiento de Puerto Rico-",
        "LUD.— ¿Esos son todos los que hay ahora?",
        "(Tr.) Nijinsky describe su actuación. Ver la nota (Ed.) y «los yanquis» (Universal [Ven.] 6.4.1999).",
    ];
    for (const text of correct) test(JSON.stringify(text), () => expect(ids(text)).toEqual([]));

    test("hyphens glued to the aside are rayas too", () => {
        expect(fix("Pero a ello se añadió -como vimos- el haberse atrevido.")).toBe(
            "Pero a ello se añadió —como vimos— el haberse atrevido.",
        );
        expect(
            fix("Su desaparición –además de por sus luchas dinásticas- se ensarta en el contexto."),
        ).toBe("Su desaparición —además de por sus luchas dinásticas— se ensarta en el contexto.");
    });
    test("dialogue quoted at the start of a line", () =>
        expect(fix("«— Los micmac creían que era mágico —dijo—. Creían en el bosque.")).toBe(
            "«—Los micmac creían que era mágico —dijo—. Creían en el bosque.",
        ));
    test("a dash joined to a question takes a space before it", () =>
        expect(fix("—Hola Ana, ¿cómo estás?—dijo Manuel.")).toBe(
            "—Hola Ana, ¿cómo estás? —dijo Manuel.",
        ));
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
