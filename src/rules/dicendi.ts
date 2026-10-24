/**
 * Verbs of saying (verba dicendi) and of the manner of saying, which open the narrator's
 * comment in a dialogue: «—Hola —dijo Juan». The infinitives are those of the
 * Libro de estilo's list, with a few more the RAE's examples use, such as «sonreír».
 */

const INFINITIVES = `abordar abroncar acentuar aclarar aconsejar acordar acreditar acusar admirar admitir
adular advertir afirmar agregar alardear alegar alegrar alentar alertar aludir amenazar amenizar
amonestar analizar animar anotar anunciar apostar apoyar apuntar argumentar argüir arremeter
arriesgar asegurar asentir aseverar asustar atacar atestiguar atribuir augurar aventurar avisar
añadir balbucear balbucir barruntar berrear bramar bromear burlar calcular censurar chillar
chismorrear citar clamar clasificar coincidir comentar comparar comprobar comprometer comunicar
concertar concluir concretar condenar confesar confiar confirmar confundir congratular conjeturar
conjurar considerar consolar constatar contabilizar contar contemporizar contestar continuar
contraatacar contradecir convenir corregir corroborar cortar cortejar cotillear criticar cuchichear
cuestionar debatir decepcionar decir declarar decretar defender definir deletrear demandar
demostrar denunciar desafiar desarmar descartar desconfiar describir descubrir desdeñar desesperar
desfogar desgañitar desistir desmentir destacar desvelar detallar determinar devolver diagnosticar
discordar disculpar discurrir discutir disentir disparar distinguir divertir ejemplificar elogiar
emocionar enfadar enfatizar enfurecer engatusar engañar enjuiciar enmendar enojar enorgullecer
entender entonar entusiasmar enumerar escandalizar esclarecer escupir espantar especificar espetar
esquivar establecer estallar estimar estipular evidenciar exagerar exclamar exhortar exigir explanar
explicar explicitar explotar exponer expresar externar exultar farfullar festejar filosofar
finalizar fingir formular fulminar garantizar gemir gritar gruñir hablar halagar hiperbolizar
historiar identificar ilustrar imaginar implorar importunar improvisar incentivar incitar increpar
indagar indicar indignar informar insinuar insistir insultar interpretar interrogar interrumpir
intervenir intuir inventar ironizar irritar jurar justificar lamentar lanzar limitar lisonjear
llamar machacar manifestar maravillar mascullar matizar meditar mencionar mentalizar mentir
minimizar mofar mostrar murmurar musitar narrar negar nombrar notar notificar objetar opinar
oponer ordenar parafrasear pedir pensar percatar piropear planear platicar ponderar precisar
preconizar predecir pregonar preguntar preocupar prevenir prever proclamar profetizar prometer
pronosticar pronunciar proponer propugnar proseguir protestar provocar puntualizar quejar
ratificar razonar reafirmar rebatir rebotar recalcar recetar reclamar recomendar recomponer
reconocer recordar reflexionar reforzar refunfuñar regañar registrar regocijar reiterar relacionar
relatar relativizar rememorar repetir replicar reprender reprobar reprochar resaltar resignar
resistir resollar resolver resoplar responder responsabilizar resumir retar retomar revelar
rezongar reñir rogar rugir seguir sentenciar sermonear señalar simplificar sintetizar sisear
solicitar sollozar soltar sostener subrayar sugerir suplicar suponer suspirar sustentar susurrar
tartajear tartamudear temer teorizar terciar terminar testimoniar titubear transmitir urdir vacilar
vanagloriar vaticinar vociferar
sonreír reír saludar inquirir observar jadear bufar carraspear apostillar zanjar atajar refutar
rematar aullar llorar despedir dudar acceder aceptar tranquilizar calmar invitar mandar jactar`;

/// Present tense with a diphthong in the stem: contar → cuenta, pensar → piensa
const DIPHTHONG: Record<string, string> = {
    contar: "cuent",
    recordar: "recuerd",
    rogar: "rueg",
    negar: "nieg",
    confesar: "confies",
    apostar: "apuest",
    acordar: "acuerd",
    mostrar: "muestr",
    demostrar: "demuestr",
    comprobar: "comprueb",
    concertar: "conciert",
    enmendar: "enmiend",
    pensar: "piens",
    recomendar: "recomiend",
    reforzar: "refuerz",
    soltar: "suelt",
    consolar: "consuel",
    resollar: "resuell",
    alentar: "alient",
    defender: "defiend",
    entender: "entiend",
    devolver: "devuelv",
    resolver: "resuelv",
    advertir: "adviert",
    sugerir: "sugier",
    mentir: "mient",
    desmentir: "desmient",
    asentir: "asient",
    disentir: "disient",
    divertir: "diviert",
    inquirir: "inquier",
};

/// Third person preterite stem with e → i, also the present's unless it diphthongs:
/// pedir → pidió, pide; advertir → advirtió (but advierte)
const E_TO_I: Record<string, string> = {
    pedir: "pid",
    despedir: "despid",
    repetir: "repit",
    gemir: "gim",
    seguir: "sigu",
    proseguir: "prosigu",
    corregir: "corrig",
    advertir: "advirt",
    sugerir: "sugir",
    mentir: "mint",
    desmentir: "desmint",
    asentir: "asint",
    disentir: "disint",
    divertir: "divirt",
};

/// Fully irregular verbs, with the forms a narrator's comment uses
const IRREGULAR: Record<string, string> = {
    decir: "dijo dijeron decía decían dice dicen dije dijimos dijiste",
    contradecir: "contradijo contradijeron contradecía contradice contradije",
    predecir: "predijo predijeron predecía predice predije",
    sostener: "sostuvo sostuvieron sostenía sostenían sostiene sostienen sostuve sostuvimos",
    oponer: "opuso opusieron oponía opone opuse",
    proponer: "propuso propusieron proponía propone propuse propusimos",
    suponer: "supuso supusieron suponía supone supuse",
    exponer: "expuso expusieron exponía expone expuse",
    recomponer: "recompuso recompusieron recomponía recompone",
    prever: "previó previeron preveía prevé preví",
    intervenir: "intervino intervinieron intervenía interviene intervienen intervine intervinimos",
    prevenir: "previno previnieron prevenía previene previne",
    convenir: "convino convinieron convenía conviene convienen convine convinimos",
    reír: "rio rió rieron reía reían ríe ríen reí reímos",
    sonreír: "sonrio sonrió sonrieron sonreía sonreían sonríe sonríen sonreí sonreímos",
    gruñir: "gruñó gruñeron gruñía gruñían gruñe gruñen gruñí",
    reñir: "riñó riñeron reñía reñían riñe riñen reñí",
};

/// Present with an accent on the stem's vowel: continuar → continúa, confiar → confía
const STRESSED: Record<string, string> = {
    acentuar: "acentú",
    continuar: "continú",
    insinuar: "insinú",
    confiar: "confí",
    desafiar: "desafí",
    desconfiar: "desconfí",
    aullar: "aúll",
};

/// First person preterite of -ar verbs, with its spelling change: explicar → expliqué
function preteriteFirst(stem: string): string {
    if (stem.endsWith("c")) return stem.slice(0, -1) + "qué";
    if (stem.endsWith("gu")) return stem.slice(0, -2) + "güé";
    if (stem.endsWith("g")) return stem + "ué";
    if (stem.endsWith("z")) return stem.slice(0, -1) + "cé";
    return stem + "é";
}

function forms(infinitive: string): string[] {
    if (IRREGULAR[infinitive]) return IRREGULAR[infinitive].split(" ");
    const stem = infinitive.slice(0, -2);
    const ending = infinitive.slice(-2);
    const present = DIPHTHONG[infinitive] ?? STRESSED[infinitive] ?? E_TO_I[infinitive] ?? stem;
    if (ending === "ar")
        return [
            stem + "ó",
            stem + "aron",
            stem + "aba",
            stem + "aban",
            present + "a",
            present + "an",
            preteriteFirst(stem),
            stem + "amos",
        ];
    // -uir verbs take a y: concluir → concluyó, concluye; argüir → arguyó
    if (/[uü]ir$/.test(infinitive) && !/[gq]uir$/.test(infinitive)) {
        const y = stem.replace(/ü$/, "u") + "y";
        return [y + "ó", y + "eron", stem + "ía", stem + "ían", y + "e", y + "en", stem + "í"];
    }
    const third = E_TO_I[infinitive] ?? stem;
    // After ñ there is no i: gruñó, riñeron
    const i = third.endsWith("ñ") ? "" : "i";
    return [
        third + i + "ó",
        third + i + "eron",
        stem + "ía",
        stem + "ían",
        present + "e",
        present + "en",
        stem + "í",
        stem + "imos",
    ];
}

/// Every form, in lower case
export const DICENDI: ReadonlySet<string> = new Set(
    INFINITIVES.split(/\s+/).filter(Boolean).flatMap(forms),
);

/// A clitic before the verb: «—se quejó», «—le contestó», «—me lo dijo»
export const CLITICS = /^(?:(?:me|te|se|le|les|lo|la|nos|os)\s+(?:(?:lo|la|los|las|le|les)\s+)?)/iu;
