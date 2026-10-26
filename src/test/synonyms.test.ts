import { afterAll, describe, expect, test } from "bun:test";
import * as Bun from "bun";
import { FileSystemAdapter } from "obsidian";
import * as api from "../api";
import { findJava, findLanguageTool, SynonymEngine, THESAURUS } from "../synonyms/engine";
import { ENGINE_JAR_SHA256 } from "../synonyms/engine-jar";
import { extractZipEntry } from "../synonyms/zip";

/**
 * The Spanish synonym engine as the plugin runs it: written to a plugin folder, with the
 * thesaurus downloaded, started with the Java and LanguageTool of this computer. Skipped when
 * either is missing.
 */
const java = await findJava("");
const languageTool = await findLanguageTool("");
const root = `${Bun.env.TMPDIR ?? "/tmp"}/lt-synonyms-test-${Date.now()}`;

/** The vault's adapter, over a temporary folder */
class TestAdapter extends FileSystemAdapter {
    getFullPath(path: string): string {
        return `${root}/${path}`;
    }
    async exists(path: string): Promise<boolean> {
        return Bun.file(this.getFullPath(path)).exists();
    }
    async mkdir(): Promise<void> {
        // Bun.write creates the folders of a file
    }
    async readBinary(path: string): Promise<ArrayBuffer> {
        return Bun.file(this.getFullPath(path)).arrayBuffer();
    }
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        await Bun.write(this.getFullPath(path), data);
    }
}

const engine = new SynonymEngine(new TestAdapter(), "plugin", () => ({
    java: "",
    languageTool: "",
}));

afterAll(() => {
    engine.stop();
    Bun.spawnSync(["rm", "-rf", root]);
});

/** Synonyms of the word in brackets, «Las [casas] son grandes» */
async function spanishSynonyms(marked: string): Promise<api.Synonym[][]> {
    const from = marked.indexOf("[");
    const to = marked.indexOf("]") - 1;
    const sentence = marked.replace("[", "").replace("]", "");
    return api.SYNONYMS.es.query(sentence, { from, to }, await engine.url());
}

const terms = (groups: api.Synonym[][]) => groups.flat().map(s => s.term);

test("a file that is not a ZIP archive is refused", async () => {
    expect(extractZipEntry(new Uint8Array(100), "x")).rejects.toThrow("Not a ZIP archive");
});

describe.skipIf(!java || !languageTool)(`Synonym engine with ${java} and ${languageTool}`, () => {
    test("starts with its files in the plugin folder", async () => {
        const address = await engine.url();
        expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const jar = new Uint8Array(
            await Bun.file(`${root}/plugin/synonyms/engine.jar`).arrayBuffer(),
        );
        const digest = new Bun.CryptoHasher("sha256").update(jar).digest("hex");
        expect(digest).toBe(ENGINE_JAR_SHA256);
        expect(Bun.file(`${root}/plugin/synonyms/${THESAURUS.file}`).size).toBe(2876858);
        expect(await Bun.file(`${root}/plugin/synonyms/${THESAURUS.license}`).text()).toContain(
            "LGPL",
        );
    }, 120000);

    test("synonyms come in the form of the word, one list per meaning", async () => {
        const groups = await spanishSynonyms("Las [casas] son grandes.");
        expect(groups.length).toBeGreaterThan(1);
        expect(terms(groups)).toContain("viviendas");
        expect(terms(groups)).toContain("domicilios");
        expect(terms(groups)).not.toContain("casa");
    });

    test("verbs take the person and tense of the word, pronominal ones their pronoun", async () => {
        expect(terms(await spanishSynonyms("El perro [corrió] rápido."))).toContain("anduvo");
        expect(terms(await spanishSynonyms("Yo [tenía] miedo."))).toContain("me comprometía");
    });

    test("an adjective with one form for both genders takes the gender of its noun", async () => {
        expect(terms(await spanishSynonyms("Las casas del pueblo son [grandes]."))).toContain(
            "desmedidas",
        );
        expect(terms(await spanishSynonyms("Los árboles son [grandes]."))).toContain("desmedidos");
    });

    test("the case of the word carries over", async () => {
        expect(terms(await spanishSynonyms("[Casas] de campo."))).toContain("Viviendas");
    });

    test("names have no synonyms, and notes come with their terms", async () => {
        expect(await spanishSynonyms("Vive en [Cruz] del Eje.")).toEqual([]);
        const noted = (await spanishSynonyms("Quiere [rebajar] el precio.")).flat();
        expect(noted).toContainEqual({ term: "humillar", note: "figurado" });
    });

    test("antonyms and words misspelt in the thesaurus are left out", async () => {
        const found = terms(await spanishSynonyms("Estaba muy [necio] aquel día."));
        expect(found).toContain("tonto");
        expect(found).not.toContain("sapiente");
        expect(found).not.toContain("distraido");
    });

    test("a stopped engine starts again on the next request, on a port of its own", async () => {
        const before = await engine.url();
        engine.stop();
        await Bun.sleep(300);
        expect(await Bun.fetch(`${before}/health`).catch(() => null)).toBeNull();
        const after = await engine.url();
        expect(await (await Bun.fetch(`${after}/health`)).json()).toEqual({
            ok: true,
            words: 21846,
        });
    }, 60000);
});
