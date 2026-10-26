"""Asks the synonym service about words in their own sentences from an Obsidian vault and
checks every answer: no errors, no duplicates or leftover notes, the case of the word, and
that each synonym comes back in the grammatical form of the word it replaces.

    python3 -I test/vault_test.py VAULT REPORT.json [--max N] [--port 8011]

Notes are only read. Folders named DICCIONARIO are skipped.
"""

import http.client
import json
import random
import re
import sys
import time
import urllib.parse
from pathlib import Path

ES = set("de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros".split())
EN = set("the of and to in is that it for was on are as with his they at be this have from or one had by but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part".split())
WORD = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+")


def spanish_sentences(vault: Path):
    for note in sorted(vault.rglob("*.md")):
        parts = note.relative_to(vault).parts
        if any(p.startswith(".") for p in parts) or any("DICCIONARIO" in p for p in parts):
            continue
        text = note.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)
        text = re.sub(r"```.*?```", " ", text, flags=re.S)
        text = re.sub(r"!?\[\[[^\]]*\]\]|\[([^\]]*)\]\([^)]*\)|https?://\S+|`[^`]*`|<[^>]+>", r" \1 ", text)
        for para in re.split(r"\n\s*\n", text):
            words = [w.lower() for w in WORD.findall(para)]
            es = sum(w in ES for w in words)
            en = sum(w in EN for w in words)
            if es < 4 or es < 2 * en:
                continue
            for sentence in re.split(r"(?<=[.!?…;:])\s+|\n", para):
                sentence = re.sub(r"[*_#>=~]+", "", sentence).strip()
                if len(WORD.findall(sentence)) >= 4:
                    yield str(note.relative_to(vault)), sentence


_connection = None


def get(port, path):
    """One kept-alive connection: a new one per request piles up closing sockets on macOS"""
    global _connection
    for attempt in range(2):
        if _connection is None:
            _connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            _connection.request("GET", path)
            response = _connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}: {body[:200]!r}")
            return json.loads(body)
        except (ConnectionError, http.client.HTTPException):
            _connection = None
            if attempt:
                raise


def patterns(tag):
    """The same tag relaxations the service uses, plus participles for adjectives"""
    out = [re.escape(tag)]
    c = tag[0]
    if c == "N" and len(tag) > 3:
        num = "[SPN]" if tag[3] == "N" else f"[{tag[3]}N]"
        out.append(tag[:2] + "." + num + re.escape(tag[4:]))
    elif c == "A" and len(tag) > 4:
        gen = "[MFC]" if tag[3] == "C" else f"[{tag[3]}C]"
        num = "[SPN]" if tag[4] == "N" else f"[{tag[4]}N]"
        out.append(tag[:2] + "." + gen + num + re.escape(tag[5:]))
        g = {"F": "F", "M": "M"}.get(tag[3], "[MF]")
        n = "P" if tag[4] == "P" else "S"
        out.append(f"VMP00{n}{g}")
    elif c == "V":
        out.append("V." + re.escape(tag[2:]))
    return [re.compile(p + "$") for p in out]


def main():
    vault = Path(sys.argv[1]).expanduser()
    report_path = Path(sys.argv[2])
    args = sys.argv[3:]
    limit = int(args[args.index("--max") + 1]) if "--max" in args else 4000
    port = int(args[args.index("--port") + 1]) if "--port" in args else 8011

    random.seed(7)
    samples, seen = [], set()
    sentences = list(spanish_sentences(vault))
    random.shuffle(sentences)
    for note, sentence in sentences:
        for m in WORD.finditer(sentence):
            word = m.group()
            if len(word) < 3 or word.lower() in ES or word.lower() in seen:
                continue
            if word.isupper() and len(word) > 1:
                continue
            seen.add(word.lower())
            before = " ".join(WORD.findall(sentence[: m.start()])[-12:])
            after = " ".join(WORD.findall(sentence[m.end():])[:12])
            samples.append((note, word, before, after))
            break  # one word per sentence spreads the sample across the vault
        if len(samples) >= limit:
            break

    tag_cache = {}

    def tags(word):
        if word not in tag_cache:
            tag_cache[word] = get(port, "/tag/es/" + urllib.parse.quote(word))["readings"]
        return tag_cache[word]

    stats = {"words": 0, "with_synonyms": 0, "synonyms": 0, "errors": 0, "slowest_ms": 0, "total_ms": 0,
             "agreement_checked": 0, "agreement_failed": 0, "unverifiable": 0}
    problems, results = [], []
    for note, word, before, after in samples:
        q = urllib.parse.urlencode({"before": before.replace(" ", "+"), "after": after.replace(" ", "+")})
        t = time.time()
        try:
            res = get(port, f"/synonyms/es/{urllib.parse.quote(word)}?{q}")
        except Exception as e:
            stats["errors"] += 1
            problems.append({"kind": "error", "note": note, "word": word, "error": str(e)})
            continue
        ms = (time.time() - t) * 1000
        stats["words"] += 1
        stats["total_ms"] += ms
        stats["slowest_ms"] = max(stats["slowest_ms"], round(ms))
        terms = [t["term"] for s in res["synsets"] for t in s["terms"]]
        if terms:
            stats["with_synonyms"] += 1
        stats["synonyms"] += len(terms)
        results.append({"note": note, "word": word, "before": before, "after": after,
                        "analysis": res["analysis"], "synsets": res["synsets"]})

        lowered = [t.lower() for t in terms]
        if len(set(lowered)) != len(lowered):
            problems.append({"kind": "duplicate", "word": word, "terms": terms})
        if word.lower() in lowered:
            problems.append({"kind": "the word itself", "word": word})
        for term in terms:
            if not term.strip() or "(" in term or ")" in term or "|" in term:
                problems.append({"kind": "malformed term", "word": word, "term": term})
            if word[0].isupper() and not term[0].isupper():
                problems.append({"kind": "case", "word": word, "term": term})

        targets = [a["tag"] for a in res["analysis"]]
        inflected = [t for t in targets if t[0] in "NAV"]
        for term in terms:
            if not inflected:
                break
            parts = term.split()
            if parts[0].lower() in ("me", "te", "se", "nos", "os") and len(parts) > 1:
                parts = parts[1:]
            if len(parts) > 1 and not any(t[0] == "V" for t in inflected):
                continue  # noun and adjective phrases are only offered for base forms
            form = parts[0]
            readings = tags(form)
            if not readings:
                stats["unverifiable"] += 1
                continue
            stats["agreement_checked"] += 1
            # «fiarse» is tagged with its clitic, «VMN0000:PP3CN000»
            term_tags = [r["tag"].split(":")[0] for r in readings]
            plain = {t[0] for t in targets if t[0] not in "NAV"}
            ok = any(p.match(tt) for t in inflected for p in patterns(t) for tt in term_tags) or any(
                tt[0] in plain for tt in term_tags)
            if not ok:
                stats["agreement_failed"] += 1
                problems.append({"kind": "form", "word": word, "targets": targets, "term": term,
                                 "term_tags": sorted({r["tag"] for r in readings}),
                                 "sentence": f"{before} [{word}] {after}"})

    stats["average_ms"] = round(stats["total_ms"] / max(1, stats["words"]), 1)
    del stats["total_ms"]
    report_path.write_text(json.dumps({"stats": stats, "problems": problems, "results": results},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))
    kinds = {}
    for p in problems:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    print("problems:", kinds)


if __name__ == "__main__":
    main()
