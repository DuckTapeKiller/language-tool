package local.ltsynonyms;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.languagetool.AnalyzedSentence;
import org.languagetool.AnalyzedToken;
import org.languagetool.AnalyzedTokenReadings;
import org.languagetool.JLanguageTool;
import org.languagetool.Language;
import org.languagetool.Languages;
import org.languagetool.synthesis.Synthesizer;
import org.languagetool.tagging.Tagger;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spanish synonyms on this computer for the Language Tool Advanced plugin, which starts it
 * (src/synonyms/engine.ts), answering like synonyms.languagetool.org:
 * GET /synonyms/es/{word}?before=…&after=… returns {"synsets":[{"terms":[{"term":…}]}]}.
 *
 * The synonyms come from a LibreOffice thesaurus file (OpenThesaurus Español). The
 * thesaurus lists base forms only, so LanguageTool's Spanish tagger finds the base form
 * and grammar of the selected word in its sentence, and LanguageTool's synthesizer puts
 * every synonym into that same form: «casas» gives «viviendas», «corrió» gives «anduvo».
 */
public final class SynonymServer {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern NOTE = Pattern.compile("\\(([^)]*)\\)");
    private static final Pattern POS_TAG = Pattern.compile("[A-Z][A-Z0-9]+");
    private static final Pattern ANTONYM = Pattern.compile("\\(Ant[^)]*nimo\\)");

    /** A synonym as the thesaurus has it, with its note («fig.», «de la nariz») if any */
    record Term(String text, String note) {}

    /** One meaning: the part of speech the thesaurus gives it, if any, and its terms */
    record Group(char category, List<Term> terms) {}

    private final Map<String, List<Group>> thesaurus;
    private final String sourceName;
    private final JLanguageTool lt;
    private final Tagger tagger;
    private final Synthesizer synthesizer;
    /** Terms LanguageTool's speller flags, and those it accepts */
    private final Map<String, Boolean> misspelt = new HashMap<>();

    SynonymServer(Path thesaurusFile, String sourceName) throws IOException {
        this.thesaurus = readThesaurus(thesaurusFile);
        this.sourceName = sourceName;
        Language spanish = Languages.getLanguageForShortCode("es");
        this.lt = new JLanguageTool(spanish);
        this.tagger = spanish.getTagger();
        this.synthesizer = spanish.getSynthesizer();
    }

    // ---- The thesaurus ------------------------------------------------------------------

    /**
     * Reads a LibreOffice «th_*_v2.dat» thesaurus: an encoding line, then for every word
     * «word|count» followed by count lines «marker|term|term…», one line per meaning.
     */
    static Map<String, List<Group>> readThesaurus(Path file) throws IOException {
        byte[] bytes = Files.readAllBytes(file);
        int firstLine = 0;
        while (firstLine < bytes.length && bytes[firstLine] != '\n') firstLine++;
        String encoding = new String(bytes, 0, firstLine, StandardCharsets.US_ASCII).trim();
        Charset charset = Charset.forName(encoding.replace("ISO8859", "ISO-8859"));
        String[] lines = new String(bytes, charset).split("\n");

        Map<String, List<Group>> words = new HashMap<>();
        int i = 1;
        while (i < lines.length) {
            String line = lines[i].strip();
            int bar = line.lastIndexOf('|');
            if (line.isEmpty() || bar < 0) {
                i++;
                continue;
            }
            String word = line.substring(0, bar).toLowerCase(Locale.ROOT);
            int count = Integer.parseInt(line.substring(bar + 1).strip());
            List<Group> groups = words.computeIfAbsent(word, w -> new ArrayList<>());
            for (int k = 1; k <= count && i + k < lines.length; k++) {
                String[] fields = lines[i + k].strip().split("\\|");
                List<Term> terms = new ArrayList<>();
                for (int f = 1; f < fields.length; f++) {
                    Term term = parseTerm(fields[f]);
                    if (term != null) terms.add(term);
                }
                if (!terms.isEmpty()) groups.add(new Group(markerCategory(fields[0]), terms));
            }
            i += count + 1;
        }
        return words;
    }

    /**
     * A term without its notes. Antonyms, which the thesaurus mixes into some meanings,
     * and words it marks as missing from the RAE's dictionary are left out.
     */
    static Term parseTerm(String raw) {
        String text = raw.strip().replace("(se)", "se");
        // The file stores «(Antónimo)» with its «ó» broken, «(Antï¿½nimo)»
        if (text.isEmpty() || ANTONYM.matcher(text).find() || text.contains("(NoRAE)")) return null;
        List<String> notes = new ArrayList<>();
        Matcher m = NOTE.matcher(text);
        while (m.find()) notes.add(noteName(m.group(1).strip()));
        text = NOTE.matcher(text).replaceAll(" ").replaceAll("\\s+", " ").strip();
        if (text.isEmpty()) return null;
        return new Term(text, notes.isEmpty() ? null : String.join(", ", notes));
    }

    static String noteName(String note) {
        return switch (note) {
            case "fig." -> "figurado";
            case "loc." -> "locución";
            case "p. us." -> "poco usado";
            case "vulg." -> "vulgar";
            default -> note;
        };
    }

    /** The word class of a meaning marked «(m.)», «(adj.)», «(tr.)»…, or a space if unmarked */
    static char markerCategory(String marker) {
        String m = marker.strip();
        if (m.startsWith("(m.") || m.startsWith("(f.")) return 'N';
        if (m.startsWith("(adj.")) return 'A';
        if (m.startsWith("(tr.") || m.startsWith("(intr.") || m.startsWith("(prnl.")) return 'V';
        return ' ';
    }

    // ---- Looking up a word --------------------------------------------------------------

    /** The base form and grammar of the selected word in its sentence */
    record Reading(String lemma, String tag) {}

    List<Reading> readings(String word, String before, String after) throws IOException {
        String prefix = before.isEmpty() ? "" : before + " ";
        String sentence = prefix + word + (after.isEmpty() ? "" : " " + after);
        List<Reading> found = new ArrayList<>();
        AnalyzedSentence analyzed = lt.getAnalyzedSentence(sentence);
        for (AnalyzedTokenReadings token : analyzed.getTokensWithoutWhitespace()) {
            if (token.getStartPos() != prefix.length() || !token.getToken().equals(word)) continue;
            addReadings(token, found);
        }
        // The sentence can split the word differently, e.g. around an apostrophe
        if (found.isEmpty()) addReadings(tagger.tag(Collections.singletonList(word)).get(0), found);
        return found;
    }

    /**
     * «grandes» is the same in both genders, its synonyms often are not: «desmedidas» for
     * «las casas», «desmedidos» for «los árboles». Give such an adjective the gender of what
     * it goes with: the disambiguator's marker inside a noun phrase («unas casas grandes»),
     * or else the nearest noun before it with the same number («las casas del pueblo son
     * grandes»). Without either it keeps both genders, and synonyms come out masculine.
     */
    List<Reading> withGender(List<Reading> readings, String word, String before, String after)
            throws IOException {
        boolean common = readings.stream()
                .anyMatch(r -> r.tag().startsWith("A") && r.tag().length() > 4 && r.tag().charAt(3) == 'C');
        if (!common) return readings;
        String prefix = before.isEmpty() ? "" : before + " ";
        String sentence = prefix + word + (after.isEmpty() ? "" : " " + after);
        AnalyzedTokenReadings[] tokens = lt.getAnalyzedSentence(sentence).getTokensWithoutWhitespace();
        int at = -1;
        for (int i = 0; i < tokens.length; i++) {
            if (tokens[i].getStartPos() == prefix.length() && tokens[i].getToken().equals(word)) at = i;
        }
        if (at < 0) return readings;
        List<Reading> result = new ArrayList<>();
        for (Reading r : readings) {
            String tag = r.tag();
            if (!tag.startsWith("A") || tag.length() <= 4 || tag.charAt(3) != 'C') {
                result.add(r);
                continue;
            }
            char gender = genderAround(tokens, at, tag.charAt(4));
            result.add(gender == 0 ? r : new Reading(r.lemma(), tag.substring(0, 3) + gender + tag.substring(4)));
        }
        return result;
    }

    /** M or F for the word at the index, 0 when the sentence does not say */
    static char genderAround(AnalyzedTokenReadings[] tokens, int at, char number) {
        for (AnalyzedToken r : tokens[at].getReadings()) {
            String t = r.getPOSTag();
            if (t != null && t.startsWith("_GN_") && t.length() > 5 && "MF".indexOf(t.charAt(4)) >= 0)
                return t.charAt(4);
        }
        for (int i = at - 1; i >= Math.max(1, at - 12); i--) {
            for (AnalyzedToken r : tokens[i].getReadings()) {
                String t = r.getPOSTag();
                if (t != null && t.startsWith("NC") && t.length() > 3 && "MF".indexOf(t.charAt(2)) >= 0
                        && (t.charAt(3) == number || number == 'N'))
                    return t.charAt(2);
            }
        }
        return 0;
    }

    /** The disambiguator's own markers on the word, such as «_GN_FP» (feminine plural) */
    List<String> markers(String word, String before, String after) throws IOException {
        String prefix = before.isEmpty() ? "" : before + " ";
        String sentence = prefix + word + (after.isEmpty() ? "" : " " + after);
        List<String> found = new ArrayList<>();
        for (AnalyzedTokenReadings token : lt.getAnalyzedSentence(sentence).getTokensWithoutWhitespace()) {
            if (token.getStartPos() != prefix.length() || !token.getToken().equals(word)) continue;
            for (AnalyzedToken r : token.getReadings()) {
                String tag = r.getPOSTag();
                if (tag != null && !POS_TAG.matcher(tag).matches() && !found.contains(tag)) found.add(tag);
            }
        }
        return found;
    }

    private static void addReadings(AnalyzedTokenReadings token, List<Reading> found) {
        for (AnalyzedToken reading : token.getReadings()) {
            String tag = reading.getPOSTag();
            String lemma = reading.getLemma();
            // Only part-of-speech tags: the disambiguator adds markers of its own, such as
            // «_GN_FP», «ignore_concordance» or «RG_before»
            if (tag == null || lemma == null || !POS_TAG.matcher(tag).matches()) continue;
            Reading r = new Reading(lemma.toLowerCase(Locale.ROOT), tag);
            if (!found.contains(r)) found.add(r);
        }
    }

    /** Synonyms of the word, grouped by meaning, each in the form of the word */
    List<List<Term>> synonyms(String word, String before, String after) throws IOException {
        String lower = word.toLowerCase(Locale.ROOT);
        List<Reading> inContext = readings(word, before, after);
        // A name, «Cruz» or «la Academia», has no synonyms
        if (!inContext.isEmpty() && inContext.stream().allMatch(r -> r.tag().startsWith("NP")))
            return List.of();

        inContext = withGender(onePerson(inContext, before), word, before, after);
        // Only the reading chosen in context: falling back on the word's other readings gave
        // other meanings, «literatura romana» → «balanza», «agosto» → «abraso»
        List<List<Term>> result = collect(word, inContext);
        // A word LanguageTool does not know may still be in the thesaurus as it is
        if (inContext.isEmpty() && thesaurus.containsKey(lower)) {
            Set<String> seen = new LinkedHashSet<>(List.of(lower));
            for (Group group : thesaurus.get(lower)) {
                List<Term> terms = new ArrayList<>();
                for (Term term : group.terms()) {
                    if (misspelt(term.text())) continue;
                    String shown = matchCase(term.text(), word);
                    if (seen.add(shown.toLowerCase(Locale.ROOT))) terms.add(new Term(shown, term.note()));
                }
                if (!terms.isEmpty()) result.add(terms);
            }
        }
        return result;
    }

    /**
     * «estaba» is first or third person; both give the same verb forms but not the same
     * pronoun for pronominal synonyms («me encontraba», «se encontraba»). Keep one person:
     * the first or second after «yo», «me», «tú», «te», otherwise the third.
     */
    static List<Reading> onePerson(List<Reading> readings, String before) {
        String[] words = before.toLowerCase(Locale.ROOT).split("\\s+");
        String last = words.length == 0 ? "" : words[words.length - 1];
        char wanted = switch (last) {
            case "yo", "me" -> '1';
            case "tú", "te", "vos" -> '2';
            default -> '3';
        };
        List<Reading> kept = new ArrayList<>();
        for (Reading r : readings) {
            String tag = r.tag();
            boolean finite = tag.startsWith("V") && tag.length() >= 6 && "123".indexOf(tag.charAt(4)) >= 0;
            if (finite && tag.charAt(4) != wanted) {
                String preferred = tag.substring(0, 4) + wanted + tag.substring(5);
                if (readings.contains(new Reading(r.lemma(), preferred))) continue;
            }
            kept.add(r);
        }
        return kept;
    }

    /**
     * The meanings of the word's base form, and of the word itself when the thesaurus lists
     * it too (plurals such as «rudimentos»), with every synonym in the word's form
     */
    List<List<Term>> collect(String word, List<Reading> readings) throws IOException {
        String lower = word.toLowerCase(Locale.ROOT);
        List<List<Term>> result = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>(List.of(lower));
        for (Reading original : readings) {
            if (original.tag().startsWith("NP")) continue;
            // A determiner or pronoun agrees like an adjective, and its synonyms are adjectives:
            // «muchas personas» → «abundantes personas»
            boolean agrees = original.tag().startsWith("D") || original.tag().startsWith("P");
            Reading reading = agrees && original.tag().length() >= 5
                    ? new Reading(original.lemma(), "AQ0" + original.tag().charAt(3) + original.tag().charAt(4) + "0")
                    : original;
            List<Group> groups = new ArrayList<>(thesaurus.getOrDefault(reading.lemma(), List.of()));
            if (!lower.equals(reading.lemma())) groups.addAll(thesaurus.getOrDefault(lower, List.of()));
            char category = reading.tag().charAt(0);
            boolean inflected = category == 'N' || category == 'A' || category == 'V';
            for (Group group : groups) {
                if (inflected && group.category() != ' ' && group.category() != category) continue;
                List<Term> terms = new ArrayList<>();
                for (Term term : group.terms()) {
                    String form = inflect(term.text(), reading);
                    if (form == null || misspelt(form)) continue;
                    String shown = matchCase(form, word);
                    if (seen.add(shown.toLowerCase(Locale.ROOT))) terms.add(new Term(shown, term.note()));
                }
                if (!terms.isEmpty()) result.add(terms);
            }
        }
        return result;
    }

    /**
     * Misspelt in the thesaurus, «deshauciado» or «esquisitez»: LanguageTool's Spanish speller
     * flags it. Only words its dictionary does not list are checked, which keeps it fast.
     */
    boolean misspelt(String term) throws IOException {
        Boolean known = misspelt.get(term);
        if (known != null) return known;
        boolean listed = true;
        for (String w : term.replaceAll("[¡!¿?,.]", " ").strip().split("\\s+")) {
            if (w.isEmpty()) continue;
            boolean tagged = tagger.tag(Collections.singletonList(w)).get(0).getReadings().stream()
                    .anyMatch(r -> r.getPOSTag() != null);
            if (!tagged) listed = false;
        }
        boolean flagged = false;
        if (!listed) {
            for (var match : lt.check(term)) {
                String id = match.getRule().getId();
                if (id.startsWith("MORFOLOGIK") || id.contains("SPELLER")) flagged = true;
            }
        }
        misspelt.put(term, flagged);
        return flagged;
    }

    // ---- Putting a synonym into the form of the word ------------------------------------

    /**
     * The synonym in the form the reading's tag describes, or null when it cannot take that
     * form, which mostly means it belongs to another word class (the noun «hazaña» among
     * the synonyms of the verb «correr»).
     */
    String inflect(String synonym, Reading reading) throws IOException {
        String tag = reading.tag();
        char category = tag.charAt(0);
        boolean inflected = category == 'N' || category == 'A' || category == 'V';
        String[] words = synonym.split(" ");
        if (!inflected) {
            // A word that does not inflect keeps synonyms of its own class: the preposition
            // «bajo» does not take the adjectives listed for «bajo»
            if (words.length > 1) return synonym;
            List<AnalyzedToken> all = tagger.tag(Collections.singletonList(synonym)).get(0).getReadings();
            boolean known = all.stream().anyMatch(r -> r.getPOSTag() != null);
            boolean sameClass = all.stream().anyMatch(r -> r.getPOSTag() != null && r.getPOSTag().charAt(0) == category);
            return !known || sameClass ? synonym : null;
        }

        if (words.length > 1) {
            // A phrase: inflect its verb when it starts with one, «darse prisa» → «se dio prisa»;
            // other phrases fit only a base form, «como una cuba» for «borracho»
            if (category == 'V' && !isBaseForm(tag)) {
                String verb = inflectVerb(words[0], tag);
                if (verb == null) return null;
                return verb + synonym.substring(words[0].length());
            }
            return isBaseForm(tag) || (category != 'V' && singular(tag)) ? synonym : null;
        }
        // Already in the form, as the thesaurus lists some plurals: «principios»
        for (String pattern : tagPatterns(tag)) {
            Pattern p = Pattern.compile(pattern);
            for (AnalyzedToken r : tagger.tag(Collections.singletonList(synonym)).get(0).getReadings()) {
                if (r.getPOSTag() != null && p.matcher(r.getPOSTag()).matches()) return synonym;
            }
        }
        if (category == 'V') return inflectVerb(synonym, tag);

        List<AnalyzedToken> known = lemmaReadings(synonym);
        if (known.stream().noneMatch(r -> r.getPOSTag().charAt(0) == category)) {
            if (category == 'A') {
                String participle = participleAsAdjective(synonym, tag);
                if (participle != null) return participle;
            }
            // Not in LanguageTool's dictionary: usable only where the word is a base form too
            return known.isEmpty() && isBaseForm(tag) && !isKnownAsOther(synonym) ? synonym : null;
        }
        for (String pattern : tagPatterns(tag)) {
            String[] forms = synthesizer.synthesize(new AnalyzedToken(synonym, null, synonym), pattern, true);
            if (forms.length > 0) return forms[0];
        }
        return null;
    }

    /** A verb, or a pronominal verb such as «apresurarse», in the form of the tag */
    String inflectVerb(String verb, String tag) throws IOException {
        String base = verb;
        boolean pronominal = false;
        if (lemmaReadings(verb).stream().noneMatch(r -> r.getPOSTag().startsWith("V"))
                && verb.endsWith("se")
                && lemmaReadings(verb.substring(0, verb.length() - 2)).stream()
                        .anyMatch(r -> r.getPOSTag().startsWith("V"))) {
            base = verb.substring(0, verb.length() - 2);
            pronominal = true;
        }
        if (lemmaReadings(base).stream().noneMatch(r -> r.getPOSTag().startsWith("V"))) return null;
        if (tag.charAt(2) == 'N') return verb; // infinitive
        String form = null;
        for (String pattern : tagPatterns(tag)) {
            String[] forms = synthesizer.synthesize(new AnalyzedToken(base, null, base), pattern, true);
            if (forms.length > 0) {
                form = forms[0];
                break;
            }
        }
        if (form == null || !pronominal) return form;
        char mood = tag.charAt(2);
        if (mood == 'G') return gerundWithSe(form);
        if (mood == 'P') return form; // participle: «apresurado»
        if (mood == 'M') return null; // imperative: «apresúrate», «apresúrese» depend on the person
        return reflexivePronoun(tag) + " " + form;
    }

    /** The pronoun of a pronominal verb in the person of the tag: «me comprometo», «nos obligamos» */
    static String reflexivePronoun(String tag) {
        if (tag.length() < 6) return "se";
        char person = tag.charAt(4);
        boolean plural = tag.charAt(5) == 'P';
        return switch (person) {
            case '1' -> plural ? "nos" : "me";
            case '2' -> plural ? "os" : "te";
            default -> "se";
        };
    }

    /**
     * A participle used as an adjective, which the dictionary lists under its verb:
     * «bebido» for «borrachas» → «bebidas»
     */
    String participleAsAdjective(String synonym, String tag) throws IOException {
        if (tag.length() < 5) return null;
        char gender = tag.charAt(3) == 'F' ? 'F' : 'M';
        char number = tag.charAt(4) == 'P' ? 'P' : 'S';
        for (AnalyzedToken r : tagger.tag(Collections.singletonList(synonym)).get(0).getReadings()) {
            String t = r.getPOSTag();
            if (t == null || !t.startsWith("VMP") || r.getLemma() == null) continue;
            String[] forms = synthesizer.synthesize(
                    new AnalyzedToken(r.getLemma(), null, r.getLemma()), "VMP00" + number + gender, true);
            if (forms.length > 0) return forms[0];
        }
        return null;
    }

    /** «apresurando» + se → «apresurándose» */
    static String gerundWithSe(String gerund) {
        if (gerund.endsWith("ando")) return gerund.substring(0, gerund.length() - 4) + "ándose";
        if (gerund.endsWith("iendo")) return gerund.substring(0, gerund.length() - 5) + "iéndose";
        if (gerund.endsWith("yendo")) return gerund.substring(0, gerund.length() - 5) + "yéndose";
        return null;
    }

    /** Readings of a word that are its own base form, i.e. the word as a dictionary entry */
    List<AnalyzedToken> lemmaReadings(String word) throws IOException {
        List<AnalyzedToken> found = new ArrayList<>();
        for (AnalyzedToken r : tagger.tag(Collections.singletonList(word)).get(0).getReadings()) {
            if (r.getPOSTag() != null && word.equalsIgnoreCase(r.getLemma())) found.add(r);
        }
        return found;
    }

    /** Known to LanguageTool, but only as a form of another word */
    boolean isKnownAsOther(String word) throws IOException {
        for (AnalyzedToken r : tagger.tag(Collections.singletonList(word)).get(0).getReadings()) {
            if (r.getPOSTag() != null) return true;
        }
        return false;
    }

    /**
     * Tag patterns for the synthesizer, the exact tag first. Nouns keep their own gender
     * («casas» → «domicilios»), adjectives that have one form for both genders take it
     * («bonitas» → «elegantes»), and a verb may be a main, auxiliary or semi-auxiliary one.
     */
    static List<String> tagPatterns(String tag) {
        List<String> patterns = new ArrayList<>();
        patterns.add(tag);
        char[] t = tag.toCharArray();
        switch (t[0]) {
            case 'N' -> {
                if (t.length > 3) {
                    t[2] = '.';
                    String number = t[3] == 'N' ? "[SPN]" : "[" + t[3] + "N]";
                    patterns.add(new String(t, 0, 3) + number + new String(t, 4, t.length - 4));
                }
            }
            case 'A' -> {
                if (t.length > 4) {
                    // Both genders and nothing in the sentence to say which: masculine first,
                    // as a dictionary lists them
                    List<String> genders = t[3] == 'C' ? List.of("[MC]", "[MFC]") : List.of("[" + t[3] + "C]");
                    String number = t[4] == 'N' ? "[SPN]" : "[" + t[4] + "N]";
                    String rest = new String(t, 5, t.length - 5);
                    for (String gender : genders) {
                        patterns.add(new String(t, 0, 3) + gender + number + rest);
                        // An adjective without a superlative or diminutive keeps the plain degree
                        patterns.add(new String(t, 0, 2) + "." + gender + number + rest);
                    }
                }
            }
            case 'V' -> {
                t[1] = '.';
                patterns.add(new String(t));
            }
            default -> {}
        }
        return patterns;
    }

    /** The form a dictionary lists: a singular noun or adjective, or an infinitive */
    static boolean isBaseForm(String tag) {
        char c = tag.charAt(0);
        if (c == 'V') return tag.length() > 2 && tag.charAt(2) == 'N';
        if (c == 'N') return singular(tag);
        if (c == 'A') return tag.length() > 4 && "MC".indexOf(tag.charAt(3)) >= 0 && singular(tag);
        return true;
    }

    static boolean singular(String tag) {
        int at = tag.charAt(0) == 'A' ? 4 : 3;
        return tag.length() > at && "SN".indexOf(tag.charAt(at)) >= 0;
    }

    /** «Casas» → «Viviendas», «CASAS» → «VIVIENDAS», «Naturalmente» → «¡Cómo no!» */
    static String matchCase(String form, String word) {
        if (word.length() > 1 && word.equals(word.toUpperCase(Locale.ROOT))) return form.toUpperCase(Locale.ROOT);
        if (!Character.isUpperCase(word.codePointAt(0))) return form;
        for (int i = 0; i < form.length(); i++) {
            if (Character.isLetter(form.charAt(i)))
                return form.substring(0, i) + Character.toUpperCase(form.charAt(i)) + form.substring(i + 1);
        }
        return form;
    }

    // ---- HTTP ----------------------------------------------------------------------------

    void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            URI uri = exchange.getRequestURI();
            String path = uri.getRawPath();
            exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            if (path.equals("/health")) {
                send(exchange, 200, Map.of("ok", true, "words", thesaurus.size()));
                return;
            }
            if (path.startsWith("/tag/es/")) {
                // What LanguageTool reads in a word; used by the tests to check the forms
                String word = URLDecoder.decode(path.substring("/tag/es/".length()), StandardCharsets.UTF_8);
                List<Map<String, String>> tags = new ArrayList<>();
                for (AnalyzedToken r : tagger.tag(Collections.singletonList(word)).get(0).getReadings()) {
                    if (r.getPOSTag() != null && r.getLemma() != null)
                        tags.add(Map.of("lemma", r.getLemma(), "tag", r.getPOSTag()));
                }
                send(exchange, 200, Map.of("readings", tags));
                return;
            }
            String prefix = "/synonyms/es/";
            if (!"GET".equals(exchange.getRequestMethod()) || !path.startsWith(prefix)) {
                send(exchange, 404, Map.of("error", "Use GET /synonyms/es/{word}"));
                return;
            }
            String word = URLDecoder.decode(path.substring(prefix.length()), StandardCharsets.UTF_8).strip();
            Map<String, String> query = query(uri.getRawQuery());
            // LanguageTool's own service takes the context with «+» between the words
            String before = query.getOrDefault("before", "").replace('+', ' ').strip();
            String after = query.getOrDefault("after", "").replace('+', ' ').strip();
            if (word.isEmpty() || word.length() > 60 || word.contains(" ")) {
                send(exchange, 400, Map.of("error", "One word is required"));
                return;
            }
            List<Map<String, Object>> synsets = new ArrayList<>();
            for (List<Term> group : synonyms(word, before, after)) {
                List<Map<String, String>> terms = new ArrayList<>();
                for (Term term : group) {
                    Map<String, String> t = new LinkedHashMap<>();
                    t.put("term", term.text());
                    if (term.note() != null) t.put("note", term.note());
                    terms.add(t);
                }
                synsets.add(Map.of("terms", terms));
            }
            List<Map<String, String>> analysis = new ArrayList<>();
            for (Reading r : readings(word, before, after))
                analysis.add(Map.of("lemma", r.lemma(), "tag", r.tag()));
            List<String> markers = markers(word, before, after);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("synsets", synsets);
            body.put("analysis", analysis);
            body.put("markers", markers);
            body.put("dataSource", Map.of("sourceName", sourceName, "license", "LGPL 2.1"));
            send(exchange, 200, body);
        } catch (Exception e) {
            e.printStackTrace();
            send(exchange, 500, Map.of("error", String.valueOf(e)));
        }
    }

    static Map<String, String> query(String raw) {
        Map<String, String> params = new HashMap<>();
        if (raw == null) return params;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            params.put(
                    URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return params;
    }

    static void send(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = new HashMap<>();
        for (int i = 0; i + 1 < args.length; i += 2) options.put(args[i], args[i + 1]);
        // 0 takes any free port; the line printed at the end says which
        int port = Integer.parseInt(options.getOrDefault("--port", "0"));
        Path file = Path.of(options.getOrDefault("--thesaurus", "th_es_v2.dat"));
        String source = options.getOrDefault("--source", "OpenThesaurus Español (RLA-ES)");

        SynonymServer synonyms = new SynonymServer(file, source);
        // Warm up the tagger, the disambiguator and the synthesizer before the first request
        synonyms.synonyms("casas", "Las", "son grandes");

        // Only this computer can reach it
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", synonyms::handle);
        // JLanguageTool is not thread-safe, so requests are answered one at a time
        server.setExecutor(Executors.newSingleThreadExecutor());
        server.start();

        // The plugin that started it keeps its input open; when the plugin goes, even without
        // stopping it, the input closes and the engine ends with it
        if (options.containsKey("--parent")) {
            Thread watcher = new Thread(() -> {
                try {
                    while (System.in.read() != -1) {
                        // nothing is sent; reading only waits for the end
                    }
                } catch (IOException e) {
                    // a broken pipe ends it too
                }
                System.exit(0);
            });
            watcher.setDaemon(true);
            watcher.start();
        }
        System.out.println("Spanish synonyms on http://127.0.0.1:" + server.getAddress().getPort()
                + " (" + synonyms.thesaurus.size() + " words)");
        System.out.flush();
    }
}
