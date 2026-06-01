from __future__ import annotations
import re
from collections import Counter
from nltk import pos_tag, word_tokenize
from nltk.collocations import BigramCollocationFinder
from nltk.metrics import BigramAssocMeasures
from nltk.corpus import stopwords as _sw  # falls back below if corpus absent

_WORD = re.compile(r"^[a-z][a-z'-]+$")
try:
    _STOP = set(_sw.words("english"))
except LookupError:  # tests/conftest downloads; prod bundles. Minimal fallback set.
    _STOP = {"the", "a", "an", "and", "or", "but", "is", "it", "this", "that", "of", "to"}

def _tokens(text: str) -> list[str]:
    return [t for t in word_tokenize((text or "").lower()) if _WORD.match(t)]

def top_adjectives(texts: list[str], *, exclude: set[str], n: int = 5) -> list[dict]:
    counts: Counter[str] = Counter()
    skip = _STOP | {e.lower() for e in exclude}
    for text in texts:
        toks = _tokens(text)
        for word, tag in pos_tag(toks):
            if tag in ("JJ", "JJR", "JJS") and word not in skip and len(word) > 2:
                counts[word] += 1
    return [{"term": w, "count": c} for w, c in counts.most_common(n)]

def top_phrases(texts: list[str], *, exclude: set[str], n: int = 5, min_freq: int = 5) -> list[dict]:
    skip = _STOP | {e.lower() for e in exclude}
    all_tokens: list[str] = []
    for text in texts:
        all_tokens.extend(t for t in _tokens(text) if t not in skip)
    if len(all_tokens) < min_freq:
        return []
    finder = BigramCollocationFinder.from_words(all_tokens)
    finder.apply_freq_filter(min_freq)              # spec §4.2: kills rare one-off pairs
    scored = finder.score_ngrams(BigramAssocMeasures().pmi)
    out = []
    for (w1, w2), _pmi in scored[:n]:
        freq = finder.ngram_fd[(w1, w2)]
        out.append({"term": f"{w1} {w2}", "count": int(freq)})
    return out
