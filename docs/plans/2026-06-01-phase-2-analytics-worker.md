# Phase 2 Analytics Worker + Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python analytics worker — pure classical-ML functions that turn a scraped-reviews S3 JSON into the `AnalyticsPayload`, plus the Lambda handler lifecycle that writes it back to the `Job` row idempotently.

**Architecture:** A focused Python package `reviewlensai_analytics` (mirrors `reviewlensai_scraper`): small single-responsibility modules (`sentiment`, `words`, `helpful`, `payload`, `s3io`, `appsync`, `main`). Pure functions are unit-tested with fixtures and no AWS; `main.handler` orchestrates them and owns the idempotency guard + conditional `Job` writes. **This plan is backend-only** — the CDK stack/deploy is the *analytics-infra* plan; the FE dashboard is the *analytics-frontend* plan. Both consume the `AnalyticsPayload` contract defined here.

**Tech Stack:** Python 3.12, NLTK (VADER + perceptron POS tagger + collocations), boto3 (S3), `requests` (AppSync over `x-api-key`), pytest + ruff.

**Spec:** `docs/specs/2026-06-01-phase-2-analytics-design.md` §3–§9 (esp. §4 deliverables, §5 payload, §7 lifecycle, §8 errors, §9 observability).

**Prerequisites (both DONE):** PR 2-A (schema has `analyticsStatus` a.string / `analyticsErrorMessage` / `analyticsJson`; `attributeExists` guard confirmed buildable) and PR 2-B (`/reviewlensai/scraper/bucketName` published).

**Environment:** scraper conventions mirrored — `[tool.pytest.ini_options] pythonpath=["src"]`, ruff line-length 100. Use a venv (`analytics/.venv`); OneDrive blocks `.bin` shims so invoke tools via the venv python. NLTK data must be present for tests (a `conftest.py` ensures it — Step in Task 1).

---

## File Structure (all under `analytics/`)

- `pyproject.toml` — package `reviewlensai-analytics`, deps `nltk`, `boto3`; dev `pytest`, `ruff`, `responses`.
- `src/reviewlensai_analytics/log.py` — `log_json` (copied from scraper).
- `src/reviewlensai_analytics/errors.py` — `S3ReadError`, `AnalyticsError`.
- `src/reviewlensai_analytics/sentiment.py` — VADER compound + weekly ISO buckets.
- `src/reviewlensai_analytics/words.py` — adjectives (POS) + phrases (PMI), partitionable.
- `src/reviewlensai_analytics/helpful.py` — top-3 helpful positive/negative.
- `src/reviewlensai_analytics/payload.py` — assemble `AnalyticsPayload`; English gate; `hasData`/`coversFullHistory`.
- `src/reviewlensai_analytics/s3io.py` — read+parse the scrape JSON.
- `src/reviewlensai_analytics/appsync.py` — `get_job` + conditional `update_job` (x-api-key).
- `src/reviewlensai_analytics/main.py` — Lambda handler (lifecycle, §7).
- `tests/` — `conftest.py` (NLTK data + a real-shaped fixture) + one test module per source module.

**The `AnalyticsPayload` contract (canonical, spec §5).** The worker emits `json.dumps(payload)` with these camelCase keys; the FE plan defines the identical TS interface. Keys: `hasData`, `coversFullHistory`, `totalAnalyzed`, `englishReviewCount`, `sentiment{weekly[{period,avgCompound,reviewCount}], analyzedAvgCompound}`, `words{overallAdjectives[], overallPhrases[], praiseAdjectives[], praisePhrases[], complaintAdjectives[], complaintPhrases[]}` (each a list of `{term,count}`), `helpful{positive[], negative[]}` (each `{text,votesUp,votesFunny,votedUp,createdAt,language,playtimeForeverHours}`).

---

## Task 1: Scaffold the package (branch + pyproject + log + smoke test)

**Files:** `analytics/pyproject.toml`, `analytics/src/reviewlensai_analytics/__init__.py`, `analytics/src/reviewlensai_analytics/log.py`, `analytics/tests/conftest.py`, `analytics/tests/test_smoke.py`

- [ ] **Step 1: Branch**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git switch main && git pull --ff-only && git switch -c phase2/analytics-worker
```

- [ ] **Step 2: Create `analytics/pyproject.toml`**

```toml
[project]
name = "reviewlensai-analytics"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["nltk>=3.9", "boto3>=1.34", "requests>=2.32"]

[project.optional-dependencies]
dev = ["pytest>=8.3", "ruff>=0.6", "responses>=0.25"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"
```
(NLTK ≥3.9 so the data packages are `vader_lexicon` + `averaged_perceptron_tagger_eng` + `punkt_tab` — see conftest.)

- [ ] **Step 3: Create the venv and install**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/analytics" \
  && python -m venv .venv \
  && .venv/Scripts/python.exe -m pip install -e ".[dev]"
```
Expected: installs `nltk`, `boto3`, `requests`, pytest, ruff, responses.

- [ ] **Step 4: `src/reviewlensai_analytics/__init__.py`** — empty file. **`src/reviewlensai_analytics/log.py`** — copy the scraper's helper verbatim:
```python
import json
import sys
from typing import Any

def _camel(s: str) -> str:
    head, *tail = s.split("_")
    return head + "".join(w.capitalize() for w in tail)

def log_json(event: str, **fields: Any) -> None:
    """Emit one structured JSON line (spec §9: jobId per line)."""
    rec = {"event": event}
    rec.update({_camel(k): v for k, v in fields.items()})
    sys.stdout.write(json.dumps(rec, default=str) + "\n")
```

- [ ] **Step 5: `tests/conftest.py`** — ensure NLTK data is available locally + provide a real-shaped reviews fixture:
```python
import nltk
import pytest

# Ensure the exact data packages NLTK >=3.9 needs (no network at runtime in prod;
# tests download once to the user's nltk_data). Names matter: the legacy
# 'punkt'/'averaged_perceptron_tagger' raise LookupError on >=3.8.2.
for pkg, path in [
    ("vader_lexicon", "sentiment/vader_lexicon"),
    ("averaged_perceptron_tagger_eng", "taggers/averaged_perceptron_tagger_eng"),
    ("punkt_tab", "tokenizers/punkt_tab"),
    ("stopwords", "corpora/stopwords"),  # words.py uses the full English stopword set
]:
    try:
        nltk.data.find(path)
    except LookupError:
        nltk.download(pkg)

def _review(rid, text, voted_up, ts, *, lang="english", votes_up=0, votes_funny=0,
            playtime=120, free=False, purchase=True, ea=False):
    return {
        "recommendationid": str(rid), "language": lang, "review": text,
        "timestamp_created": ts, "timestamp_updated": ts, "voted_up": voted_up,
        "votes_up": votes_up, "votes_funny": votes_funny, "steam_purchase": purchase,
        "received_for_free": free, "written_during_early_access": ea,
        "author": {"playtime_at_review": playtime, "playtime_forever": playtime},
    }

@pytest.fixture
def make_review():
    return _review
```

- [ ] **Step 6: `tests/test_smoke.py`**
```python
from reviewlensai_analytics.log import log_json

def test_log_json_is_importable(capsys):
    log_json("worker_start", job_id="abc")
    out = capsys.readouterr().out
    assert '"event": "worker_start"' in out and '"jobId": "abc"' in out
```

- [ ] **Step 7: Run + commit**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/analytics" \
  && .venv/Scripts/python.exe -m pytest -q && .venv/Scripts/ruff.exe check src tests
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && printf '.venv/\nbuild/\n__pycache__/\n*.pyc\n' > analytics/.gitignore \
  && git add analytics/pyproject.toml analytics/src analytics/tests analytics/.gitignore \
  && git commit -m "feat(analytics): scaffold reviewlensai_analytics package + log helper"
```
Expected: smoke test passes; ruff clean.

---

## Task 2: Sentiment series (`sentiment.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/sentiment.py`, `analytics/tests/test_sentiment.py`

- [ ] **Step 1: Failing tests**
```python
from datetime import datetime, timezone
from reviewlensai_analytics.sentiment import iso_week_key, weekly_sentiment

def ts(y, m, d):  # UTC epoch seconds
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp())

def test_iso_week_key_uses_iso_week_year_at_boundary():
    # 2024-12-30 is ISO week 2025-W01 (iso_year != calendar year)
    assert iso_week_key(ts(2024, 12, 30)) == "2025-W01"
    assert iso_week_key(ts(2021, 1, 1)) == "2020-W53"

def test_weekly_sentiment_buckets_and_counts(make_review):
    reviews = [
        make_review(1, "I love this game, amazing!", True, ts(2024, 1, 8)),
        make_review(2, "great fun", True, ts(2024, 1, 9)),       # same ISO week
        make_review(3, "terrible, broken garbage", False, ts(2024, 1, 15)),  # next week
    ]
    weekly, analyzed_avg = weekly_sentiment(reviews)
    by = {b["period"]: b for b in weekly}
    assert by["2024-W02"]["reviewCount"] == 2
    assert by["2024-W03"]["reviewCount"] == 1
    assert by["2024-W02"]["avgCompound"] > 0   # positive text
    assert by["2024-W03"]["avgCompound"] < 0   # negative text
    assert weekly == sorted(weekly, key=lambda b: b["period"])  # chronological
    assert -1.0 <= analyzed_avg <= 1.0

def test_weekly_sentiment_empty_returns_none_avg():
    assert weekly_sentiment([]) == ([], None)
```

- [ ] **Step 2: Run → fail** (`.venv/Scripts/python.exe -m pytest tests/test_sentiment.py -q`).

- [ ] **Step 3: Implement `sentiment.py`**
```python
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from nltk.sentiment.vader import SentimentIntensityAnalyzer

_VADER = SentimentIntensityAnalyzer()  # module-level: load lexicon once per Lambda

def iso_week_key(ts: int) -> str:
    iso = datetime.fromtimestamp(ts, tz=timezone.utc).isocalendar()
    return f"{iso.year}-W{iso.week:02d}"  # ISO week-YEAR, not calendar year

def compound(text: str) -> float:
    return _VADER.polarity_scores(text or "")["compound"]

def weekly_sentiment(reviews: list[dict[str, Any]]) -> tuple[list[dict], float | None]:
    """Weekly ISO buckets of mean VADER compound + review count, chronological.
    Caller passes the English subset (VADER is English). Returns (weekly, analyzedAvg)."""
    if not reviews:
        return [], None
    buckets: dict[str, list[float]] = defaultdict(list)
    all_scores: list[float] = []
    for r in reviews:
        c = compound(r.get("review", ""))
        all_scores.append(c)
        buckets[iso_week_key(int(r["timestamp_created"]))].append(c)
    weekly = [
        {"period": k, "avgCompound": round(sum(v) / len(v), 4), "reviewCount": len(v)}
        for k, v in sorted(buckets.items())
    ]
    analyzed = round(sum(all_scores) / len(all_scores), 4)
    return weekly, analyzed
```

- [ ] **Step 4: Run → pass; ruff; commit**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/analytics" \
  && .venv/Scripts/python.exe -m pytest tests/test_sentiment.py -q && .venv/Scripts/ruff.exe check src tests
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add analytics/src/reviewlensai_analytics/sentiment.py analytics/tests/test_sentiment.py \
  && git commit -m "feat(analytics): weekly VADER sentiment series (ISO week-year, UTC)"
```

---

## Task 3: Word association (`words.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/words.py`, `analytics/tests/test_words.py`

- [ ] **Step 1: Failing tests**
```python
from reviewlensai_analytics.words import top_adjectives, top_phrases

def test_top_adjectives_extracts_jj_and_filters_stopwords_and_gamename():
    texts = ["The combat is brutal but gorgeous", "gorgeous art, brutal difficulty",
             "a brutal, gorgeous masterpiece"]
    adj = top_adjectives(texts, exclude={"hollow", "knight"}, n=5)
    terms = [a["term"] for a in adj]
    assert "brutal" in terms and "gorgeous" in terms
    assert all(a["count"] >= 1 for a in adj)
    assert adj == sorted(adj, key=lambda a: -a["count"])  # desc by count

def test_top_phrases_requires_min_frequency():
    # a one-off rare bigram must NOT outrank a frequent one; the frequent one MUST survive
    texts = ["great game"] * 6 + ["zxqw plooble"]   # 'zxqw plooble' appears once
    phrases = top_phrases(texts, exclude=set(), n=5, min_freq=5)
    joined = [p["term"] for p in phrases]
    assert "great game" in joined          # frequent bigram survives the freq filter
    assert "zxqw plooble" not in joined     # one-off filtered out (would falsely top PMI)
    assert phrases[0]["term"] == "great game" and phrases[0]["count"] == 6

def test_empty_inputs_return_empty():
    assert top_adjectives([], exclude=set()) == []
    assert top_phrases([], exclude=set()) == []
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `words.py`**
```python
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
```

- [ ] **Step 4: Run → pass; ruff; commit** (`feat(analytics): word association (POS adjectives + PMI phrases)`).

---

## Task 4: Helpful reviews (`helpful.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/helpful.py`, `analytics/tests/test_helpful.py`

- [ ] **Step 1: Failing tests**
```python
from reviewlensai_analytics.helpful import helpful_reviews

def test_top3_pos_neg_by_votes_up_min1(make_review):
    rv = [
        make_review(1, "good", True, 100, votes_up=10),
        make_review(2, "good2", True, 100, votes_up=5),
        make_review(3, "good3", True, 100, votes_up=1),
        make_review(4, "good4-ignored", True, 100, votes_up=0),  # 0 votes -> excluded
        make_review(5, "bad", False, 100, votes_up=8),
    ]
    pos, neg = helpful_reviews(rv)
    assert [r["votesUp"] for r in pos] == [10, 5, 1]   # top3 desc, votes_up>=1
    assert len(neg) == 1 and neg[0]["votesUp"] == 8
    assert pos[0]["votedUp"] is True and neg[0]["votedUp"] is False

def test_text_capped_and_playtime_hours(make_review):
    long = "x" * 5000
    pos, _ = helpful_reviews([make_review(1, long, True, 100, votes_up=3, playtime=180)])
    assert len(pos[0]["text"]) == 1000
    assert pos[0]["playtimeForeverHours"] == 3.0   # 180 min / 60
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `helpful.py`**
```python
from __future__ import annotations
from typing import Any

_TEXT_CAP = 1000

def _hours(minutes: Any) -> float | None:
    return round(minutes / 60, 1) if isinstance(minutes, (int, float)) else None

def _shape(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": (r.get("review") or "")[:_TEXT_CAP],
        "votesUp": int(r.get("votes_up", 0)),
        "votesFunny": int(r.get("votes_funny", 0)),
        "votedUp": bool(r.get("voted_up")),
        "createdAt": int(r.get("timestamp_created", 0)),
        "language": r.get("language", ""),
        "playtimeForeverHours": _hours((r.get("author") or {}).get("playtime_forever")),
    }

def helpful_reviews(reviews: list[dict[str, Any]]) -> tuple[list[dict], list[dict]]:
    """Top-3 positive + top-3 negative with votes_up>=1, ranked votes_up desc,
    tiebreak votes_funny desc then newer (spec §4.3). Language-agnostic."""
    eligible = [r for r in reviews if int(r.get("votes_up", 0)) >= 1]
    key = lambda r: (int(r.get("votes_up", 0)), int(r.get("votes_funny", 0)), int(r.get("timestamp_created", 0)))
    pos = sorted([r for r in eligible if r.get("voted_up")], key=key, reverse=True)[:3]
    neg = sorted([r for r in eligible if not r.get("voted_up")], key=key, reverse=True)[:3]
    return [_shape(r) for r in pos], [_shape(r) for r in neg]
```

- [ ] **Step 4: Run → pass; ruff; commit** (`feat(analytics): top helpful positive/negative reviews`).

---

## Task 5: Payload assembly (`payload.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/payload.py`, `analytics/tests/test_payload.py`

- [ ] **Step 1: Failing tests**
```python
from reviewlensai_analytics.payload import build_payload

MIN_EN = 20

def _doc(reviews, total_reviews=None, game_name="Hollow Knight"):
    return {"game": {"name": game_name}, "summary": {"totalReviews": total_reviews if total_reviews is not None else len(reviews)}, "reviews": reviews}

def test_empty_reviews_hasdata_false(make_review):
    p = build_payload(_doc([]))
    assert p["hasData"] is False and p["sentiment"]["weekly"] == [] and p["helpful"]["positive"] == []

def test_below_english_gate_empties_nlp_keeps_helpful(make_review):
    rv = [make_review(i, "good", True, 100, votes_up=2, lang="schinese") for i in range(30)]
    p = build_payload(_doc(rv))
    assert p["hasData"] is True
    assert p["englishReviewCount"] == 0
    assert p["sentiment"]["weekly"] == [] and p["words"]["overallAdjectives"] == []
    assert len(p["helpful"]["positive"]) == 3   # language-agnostic, still populated

def test_covers_full_history_flag(make_review):
    rv = [make_review(i, "good game brutal gorgeous", True, 100 + i) for i in range(MIN_EN + 5)]
    assert build_payload(_doc(rv, total_reviews=len(rv)))["coversFullHistory"] is True
    assert build_payload(_doc(rv, total_reviews=999999))["coversFullHistory"] is False

def test_english_gate_boundary(make_review):
    # 19 English -> below gate (NLP empty); 20 -> at gate (NLP populated)
    below = [make_review(i, "brutal gorgeous combat great fun", True, 100 + i) for i in range(19)]
    at = below + [make_review(99, "brutal gorgeous combat great fun", True, 999)]
    assert build_payload(_doc(below))["sentiment"]["weekly"] == []
    assert build_payload(_doc(at))["sentiment"]["weekly"] != []

def test_all_positive_empties_complaints(make_review):
    rv = [make_review(i, "brutal gorgeous combat great fun", True, 100 + i) for i in range(25)]
    p = build_payload(_doc(rv))
    assert p["words"]["complaintAdjectives"] == [] and p["words"]["complaintPhrases"] == []
    assert p["words"]["praiseAdjectives"] != []  # praise populated
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `payload.py`**
```python
from __future__ import annotations
from typing import Any
from .sentiment import weekly_sentiment
from .words import top_adjectives, top_phrases
from .helpful import helpful_reviews

MIN_ENGLISH = 20  # spec §4: below this, NLP sections are emitted empty

def _english(reviews: list[dict]) -> list[dict]:
    return [r for r in reviews if r.get("language") == "english"]

def build_payload(doc: dict[str, Any]) -> dict[str, Any]:
    reviews = doc.get("reviews") or []
    summary = doc.get("summary") or {}
    game_name = ((doc.get("game") or {}).get("name") or "")
    total_reviews = int(summary.get("totalReviews") or 0)

    english = _english(reviews)
    has_data = len(reviews) > 0
    nlp_ok = len(english) >= MIN_ENGLISH

    weekly, analyzed_avg = weekly_sentiment(english) if nlp_ok else ([], None)
    exclude = set(game_name.lower().split())
    en_texts = [r.get("review", "") for r in english]
    pos_texts = [r.get("review", "") for r in english if r.get("voted_up")]
    neg_texts = [r.get("review", "") for r in english if not r.get("voted_up")]
    words = {
        "overallAdjectives": top_adjectives(en_texts, exclude=exclude) if nlp_ok else [],
        "overallPhrases": top_phrases(en_texts, exclude=exclude) if nlp_ok else [],
        "praiseAdjectives": top_adjectives(pos_texts, exclude=exclude) if nlp_ok else [],
        "praisePhrases": top_phrases(pos_texts, exclude=exclude) if nlp_ok else [],
        "complaintAdjectives": top_adjectives(neg_texts, exclude=exclude) if nlp_ok else [],
        "complaintPhrases": top_phrases(neg_texts, exclude=exclude) if nlp_ok else [],
    }
    pos, neg = helpful_reviews(reviews)  # language-agnostic
    return {
        "hasData": has_data,
        "coversFullHistory": len(reviews) >= total_reviews,
        "totalAnalyzed": len(reviews),
        "englishReviewCount": len(english),
        "sentiment": {"weekly": weekly, "analyzedAvgCompound": analyzed_avg},
        "words": words,
        "helpful": {"positive": pos, "negative": neg},
    }
```

- [ ] **Step 4: Run → pass; ruff; commit** (`feat(analytics): assemble AnalyticsPayload (English gate, coversFullHistory)`).

- [ ] **Step 5: Commit a SHARED canonical-output fixture (contract enforcement)**

The FE plan needs a sample `AnalyticsPayload` for its `FakeAmplifyClient` + `parseAnalytics`
tests anyway (spec §10). Make it a **single shared artifact** both domains load, so the
two hand-maintained mirrors (this Python dict + the FE TS interface) can't drift silently.
Write `analytics/tests/fixtures/analytics_payload.example.json` containing a representative
payload (all 6 word lists non-empty, ≥1 weekly bucket, 1–2 helpful each), then add a test:
```python
import json, pathlib
def test_canonical_fixture_has_exact_payload_keys(make_review):
    fx = json.loads((pathlib.Path(__file__).parent / "fixtures/analytics_payload.example.json").read_text())
    sample = build_payload(_doc([make_review(i, "brutal gorgeous combat great fun game", True, 100 + i) for i in range(25)]))
    assert set(fx) == set(sample)                                  # top-level keys match
    assert set(fx["sentiment"]) == set(sample["sentiment"])
    assert set(fx["words"]) == set(sample["words"])
    assert set(fx["helpful"]) == set(sample["helpful"])
```
Commit the fixture + test (`test(analytics): shared canonical AnalyticsPayload fixture`). **The FE plan MUST load this same file** (copy it to the app test tree or reference it) so a key rename on either side fails a test. *(POS-pass note: `build_payload` runs `top_adjectives`/`top_phrases` six times, POS-tagging each English review ~twice (overall + its partition). Accepted for the PoC at ≤10k reviews — well within the 600s Lambda budget; revisit with a tag-once helper only if the worker times out. This supersedes spec §7's "one pass per partition" wording.)*

---

## Task 6: S3 reader (`s3io.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/s3io.py`, `analytics/src/reviewlensai_analytics/errors.py`, `analytics/tests/test_s3io.py`

- [ ] **Step 1: Failing tests** (mock boto3 S3 client)
```python
import json, pytest
from reviewlensai_analytics.s3io import read_scrape_json
from reviewlensai_analytics.errors import S3ReadError

class _Body:
    def __init__(self, b): self._b = b
    def read(self): return self._b

class _S3Ok:
    def get_object(self, Bucket, Key): return {"Body": _Body(json.dumps({"reviews": []}).encode())}

class _S3Err:
    def get_object(self, Bucket, Key): raise RuntimeError("boom")

def test_reads_and_parses():
    assert read_scrape_json(_S3Ok(), "b", "jobs/x/1.json") == {"reviews": []}

def test_wraps_failure_as_s3readerror():
    with pytest.raises(S3ReadError):
        read_scrape_json(_S3Err(), "b", "k")

def test_bad_json_is_s3readerror():
    class _Bad:
        def get_object(self, **k): return {"Body": _Body(b"not json")}
    with pytest.raises(S3ReadError):
        read_scrape_json(_Bad(), "b", "k")
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `errors.py`**
```python
class S3ReadError(Exception): ...       # spec §8: "Couldn't read scrape data."
```
(The catch-all "Analytics failed." path is a bare `except Exception` in `main.py` — no
dedicated class needed; don't add an unused `AnalyticsError`.)
and `s3io.py`
```python
from __future__ import annotations
import json
from typing import Any
from .errors import S3ReadError

def read_scrape_json(s3_client: Any, bucket: str, key: str) -> dict[str, Any]:
    try:
        body = s3_client.get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(body)
    except Exception as e:  # boto ClientError, network, JSON decode
        raise S3ReadError(str(e)) from e
```

- [ ] **Step 4: Run → pass; ruff; commit** (`feat(analytics): S3 scrape reader + error taxonomy`).

---

## Task 7: AppSync client (`appsync.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/appsync.py`, `analytics/tests/test_appsync.py`

Mirrors the scraper's `appsync.py` (x-api-key, 1 retry on 5xx/network, `ConditionalCheckFailed` → no-op). Adds `get_job` and an `update_analytics` that guards `analyticsStatus`.

- [ ] **Step 1: Failing tests** (use `responses` to mock the GraphQL endpoint)
```python
import responses
from reviewlensai_analytics.appsync import AppSyncClient

URL = "https://x.example/graphql"

@responses.activate
def test_update_running_guarded_on_attribute_not_exists():
    responses.post(URL, json={"data": {"updateJob": {"id": "j1", "analyticsStatus": "RUNNING"}}})
    ok = AppSyncClient(URL, "k").update_analytics("j1", status="RUNNING", guard_not_started=True)
    assert ok is True
    body = responses.calls[0].request.body
    assert "RUNNING" in body and "attributeExists" in body  # guard present

@responses.activate
def test_conditional_miss_is_noop_not_raise():
    responses.post(URL, json={"errors": [{"errorType": "ConditionalCheckFailedException", "message": "x"}]})
    assert AppSyncClient(URL, "k").update_analytics("j1", status="RUNNING", guard_not_started=True) is False

@responses.activate
def test_get_job_returns_row():
    responses.post(URL, json={"data": {"getJob": {"id": "j1", "status": "SUCCEEDED", "analyticsStatus": None, "s3Key": "k"}}})
    assert AppSyncClient(URL, "k").get_job("j1")["status"] == "SUCCEEDED"
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `appsync.py`**
```python
from __future__ import annotations
import time
from typing import Any
import requests
from .log import log_json

class AppSyncError(Exception): ...

_JOB_FIELDS = "id status s3Key analyticsStatus"
_GET = f"query Get($id: ID!) {{ getJob(id: $id) {{ {_JOB_FIELDS} analyticsJson }} }}"
_UPDATE = (
    "mutation Update($input: UpdateJobInput!, $cond: ModelJobConditionInput) "
    f"{{ updateJob(input: $input, condition: $cond) {{ {_JOB_FIELDS} }} }}"
)

class AppSyncClient:
    def __init__(self, url: str, api_key: str, timeout: int = 10):
        self.url, self.api_key, self.timeout = url, api_key, timeout

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self._post(_GET, {"id": job_id}).get("getJob")

    def update_analytics(self, job_id: str, *, status: str, guard_not_started: bool = False,
                         analytics_json: str | None = None, error_message: str | None = None) -> bool:
        inp: dict[str, Any] = {"id": job_id, "analyticsStatus": status}
        if analytics_json is not None:
            inp["analyticsJson"] = analytics_json
        if error_message is not None:
            inp["analyticsErrorMessage"] = error_message
        # Guard: null->RUNNING uses attribute_not_exists; later transitions guard on prior status.
        cond = ({"analyticsStatus": {"attributeExists": False}} if guard_not_started
                else {"analyticsStatus": {"eq": "RUNNING"}})
        data, errors = self._post(_UPDATE, {"input": inp, "cond": cond}, tolerate_errors=True)
        if errors:
            if any("ConditionalCheckFailed" in (e.get("errorType", "") + e.get("message", "")) for e in errors):
                log_json("appsync_condition_noop", job_id=job_id, analytics_status=status)
                return False
            raise AppSyncError(str(errors))
        return True

    def _post(self, query: str, variables: dict, tolerate_errors: bool = False) -> Any:
        last: Exception | None = None
        for attempt in range(2):  # 1 retry on 5xx/network, 500ms backoff (spec §8)
            try:
                r = requests.post(self.url, json={"query": query, "variables": variables},
                                  headers={"x-api-key": self.api_key, "content-type": "application/json"},
                                  timeout=self.timeout)
                if r.status_code >= 500:
                    raise AppSyncError(f"HTTP {r.status_code}")
                body = r.json()
                errors = body.get("errors")
                if tolerate_errors:
                    return body.get("data"), errors
                if errors:
                    raise AppSyncError(str(errors))
                return body.get("data")
            except (requests.RequestException, AppSyncError) as e:
                last = e
                if attempt == 0:
                    time.sleep(0.5)
        raise AppSyncError(f"AppSync call failed after retries: {last}")
```

- [ ] **Step 4: Run → pass; ruff; commit** (`feat(analytics): AppSync client (getJob + guarded analytics update)`).

---

## Task 8: Handler lifecycle (`main.py`, TDD)

**Files:** `analytics/src/reviewlensai_analytics/main.py`, `analytics/tests/test_main.py`

Implements spec §7: parse event → idempotency guard → `RUNNING` (attributeExists guard) → read S3 → build payload → `SUCCEEDED`+json, or `FAILED`+message (§8). Observability events per §9 (`worker_invoked`, `worker_skipped{reason}`, `worker_running`, `worker_complete`, `worker_empty`, `worker_s3_read_failed`, `worker_failed`).

- [ ] **Step 1: Failing tests** (inject fakes for AppSyncClient + S3 + a payload builder via module seams)
```python
import json
from reviewlensai_analytics import main

class FakeAS:
    def __init__(self, row): self.row = row; self.updates = []
    def get_job(self, jid): return self.row
    def update_analytics(self, jid, **kw):
        self.updates.append(kw)
        # simulate attribute_not_exists winning once
        if kw.get("guard_not_started"): return self.row.get("analyticsStatus") is None
        return True

def _event(jid="j1", key="jobs/j1/1.json"):
    return {"detail": {"jobId": jid, "s3Key": key}}

def test_skips_when_already_started(monkeypatch):
    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": "SUCCEEDED"})
    monkeypatch.setattr(main, "_client", lambda: fas)
    out = main.handler(_event(), None)
    assert out["skipped"] == "already_started" and fas.updates == []

def test_happy_path_writes_running_then_succeeded(monkeypatch):
    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: {"game": {"name": "G"}, "summary": {"totalReviews": 0}, "reviews": []})
    out = main.handler(_event(), None)
    assert [u["status"] for u in fas.updates] == ["RUNNING", "SUCCEEDED"]
    assert json.loads(fas.updates[1]["analytics_json"])["hasData"] is False

def test_s3_failure_writes_failed_message(monkeypatch):
    from reviewlensai_analytics.errors import S3ReadError
    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})
    monkeypatch.setattr(main, "_client", lambda: fas)
    def boom(key): raise S3ReadError("x")
    monkeypatch.setattr(main, "_read_doc", boom)
    main.handler(_event(), None)
    assert fas.updates[-1]["status"] == "FAILED"
    assert fas.updates[-1]["error_message"] == "Couldn't read scrape data."

def test_terminal_write_exception_reraises_for_dlq(monkeypatch):
    import pytest
    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})
    def update(jid, **kw):
        if kw.get("guard_not_started"):
            return True                       # win the RUNNING guard
        raise RuntimeError("appsync down")    # terminal SUCCEEDED write fails
    fas.update_analytics = update
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: {"reviews": []})
    with pytest.raises(RuntimeError):         # re-raised → non-zero exit → DLQ (spec §8)
        main.handler(_event(), None)
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `main.py`**
```python
from __future__ import annotations
import json
import os
from typing import Any
import boto3
from .appsync import AppSyncClient
from .errors import S3ReadError
from .payload import build_payload
from .s3io import read_scrape_json
from .log import log_json

_S3 = boto3.client("s3")

def _client() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])

def _read_doc(key: str) -> dict[str, Any]:
    return read_scrape_json(_S3, os.environ["S3_BUCKET"], key)

def _write_terminal(client: AppSyncClient, job_id: str, status: str, **kw: Any) -> dict[str, Any]:
    """Terminal SUCCEEDED/FAILED write (guarded on RUNNING). On a write EXCEPTION,
    emit worker_failed_terminal_write_failed and re-raise → non-zero exit → DLQ (spec §8)."""
    try:
        if not client.update_analytics(job_id, status=status, **kw):
            log_json("worker_failed_terminal_write_failed", job_id=job_id, status=status, reason="guard_miss")
    except Exception as e:  # noqa: BLE001
        log_json("worker_failed_terminal_write_failed", job_id=job_id, status=status, error=str(e))
        raise
    return {"status": status}

def handler(event: dict[str, Any], _ctx: Any) -> dict[str, Any]:
    detail = (event or {}).get("detail") or {}
    job_id, s3_key = detail.get("jobId"), detail.get("s3Key")
    log_json("worker_invoked", job_id=job_id)
    if not job_id or not s3_key:
        log_json("worker_skipped", reason="no_jobid")
        return {"skipped": "no_jobid"}

    client = _client()
    row = client.get_job(job_id)
    if not row:
        log_json("worker_skipped", reason="no_row", job_id=job_id); return {"skipped": "no_row"}
    if row.get("status") != "SUCCEEDED":
        log_json("worker_skipped", reason="not_succeeded", job_id=job_id); return {"skipped": "not_succeeded"}
    if row.get("analyticsStatus") is not None:
        log_json("worker_skipped", reason="already_started", job_id=job_id); return {"skipped": "already_started"}

    # Atomic idempotency gate: attribute_not_exists(analyticsStatus). Duplicate deliveries lose here.
    if not client.update_analytics(job_id, status="RUNNING", guard_not_started=True):
        log_json("worker_skipped", reason="lost_guard_race", job_id=job_id); return {"skipped": "lost_guard_race"}
    log_json("worker_running", job_id=job_id)

    try:
        doc = _read_doc(s3_key)
        payload = build_payload(doc)
    except S3ReadError as e:
        log_json("worker_s3_read_failed", job_id=job_id, error=str(e))
        return _write_terminal(client, job_id, "FAILED", error_message="Couldn't read scrape data.")
    except Exception as e:  # noqa: BLE001 — catch-all is the spec's error taxonomy (§8)
        log_json("worker_failed", job_id=job_id, error=str(e))
        return _write_terminal(client, job_id, "FAILED", error_message="Analytics failed.")
    # Compute succeeded → terminal SUCCEEDED write (separate from the compute try/except so a
    # SUCCEEDED-write failure is NOT re-caught and flipped to FAILED).
    log_json("worker_empty" if not payload["hasData"] else "worker_complete",
             job_id=job_id, has_data=payload["hasData"], english=payload["englishReviewCount"])
    res = _write_terminal(client, job_id, "SUCCEEDED", analytics_json=json.dumps(payload))
    res["hasData"] = payload["hasData"]
    return res
```

- [ ] **Step 4: Run full suite + ruff; commit**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/analytics" \
  && .venv/Scripts/python.exe -m pytest -q && .venv/Scripts/ruff.exe check src tests
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add analytics/src/reviewlensai_analytics/main.py analytics/tests/test_main.py \
  && git commit -m "feat(analytics): worker handler lifecycle (idempotency guard + error taxonomy)"
```
Expected: full suite green; ruff clean.

---

## Definition of Done (maps to spec §3–§9)

- [ ] `reviewlensai_analytics` package: sentiment (weekly ISO/UTC), words (POS adjectives + PMI phrases, overall/praise/complaint), helpful (top-3 pos/neg), payload (English gate ≥20, `hasData`, `coversFullHistory`), s3io, appsync (attributeExists guard), main (full §7 lifecycle + §8 taxonomy + §9 events).
- [ ] `AnalyticsPayload` keys exactly match spec §5 (FE plan's TS interface must match these).
- [ ] Unit tests cover edge cases: empty, sub-gate English, year-boundary weeks, helpful ties/<3, PMI min-freq, S3 failure, idempotency skip + guard-race.
- [ ] pytest + ruff green; committed in attributable commits on `phase2/analytics-worker`.
- [ ] **Not here (but flagged for the infra plan):** the Lambda packaging + CDK stack + deploy.
  - The prod NLTK bundle MUST include **all four** data packages: `vader_lexicon`,
    `averaged_perceptron_tagger_eng`, `punkt_tab`, **and `stopwords`** (words.py uses
    the full English stopword set; without it `_STOP` silently degrades to a 12-word
    fallback). Update spec §6/§11's bundle list to add `stopwords`.
  - **`sentiment.py` instantiates VADER at module import** (`_VADER = SentimentIntensityAnalyzer()`),
    so a missing/mis-pathed `NLTK_DATA` bundle is an **import-time Lambda crash** that
    bypasses the §8 error taxonomy. The infra plan's §11 **no-network smoke test MUST
    `import reviewlensai_analytics.sentiment` and `...words`** under the bundled
    `NLTK_DATA` (network disabled) to catch a mis-bundle before deploy.

---

## Self-Review notes
- **Spec coverage:** §4.1→Task 2; §4.2/§4.5→Task 3; §4.3→Task 4; §4 gate + §5 + §4.4 volume(reviewCount in buckets)→Task 5; §8 S3 error→Task 6; §3 guard/§8 retry→Task 7; §7 lifecycle/§9 events→Task 8. No gaps. (Volume-over-time is the `reviewCount` already in each weekly bucket — no separate code, per §4.4.)
- **Contract single-source:** the camelCase keys in `payload.py` ARE the contract; the FE plan's `app/src/types/analytics.ts` interface must mirror them exactly (it will be cross-checked there).
- **No deploy dependency:** all tests mock S3/AppSync and run offline; NLTK data is fetched by `conftest.py` for tests (prod bundling is the infra plan's job). This plan is safe to fully execute and review without touching AWS.
- **Type consistency:** `update_analytics(status=...)` values are exactly `"RUNNING"|"SUCCEEDED"|"FAILED"`; `_JOB_FIELDS` here is the worker's *own* minimal response selectionSet (id/status/s3Key/analyticsStatus/analyticsJson), distinct from the scraper's 18-field selectionSet. **Spec §3 was amended (after plan-DA) to explicitly exempt the worker from the full-row rule** — safe because the worker never consumes the response and the FE's `observeQuery` re-reads full snapshots.
