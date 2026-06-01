# Phase 1 — Scraper Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two Python Lambdas (Validator + async Scraper) and their CDK stack so a Steam URL is validated synchronously, then scraped (≤10k reviews) into S3 with the `Job` row driven through `PENDING→RUNNING→SUCCEEDED/FAILED` via AppSync, emitting a `ScrapeSucceeded` event for Phase 2.

**Architecture:** A public Function URL Lambda (Validator) shape-checks the URL, confirms the game via Steam `appdetails`, creates the `Job(PENDING)` over AppSync (x-api-key), and async-invokes the Scraper passing the already-fetched `appdetails` payload. The Scraper guards `PENDING→RUNNING`, paginates `appreviews` with dedup + termination, writes `jobs/{jobId}/{appId}.json` to S3, flips `SUCCEEDED`, and emits to a custom EventBridge bus. Backend AppSync writes use the API key (no IAM signing). Failures map to a closed error-string set; hard crashes go to a DLQ (alarmed).

**Tech Stack:** Python 3.12, `pytest`, `ruff`, `urllib`/`requests`, `boto3`; AWS CDK (TypeScript) for IaC. Real captured Steam JSON as test fixtures.

**Spec:** `docs/specs/2026-06-01-phase-1-design.md` (v2.1) — implements §4, §6 (scraper side), §7, §8 (scraper), §9.
**Depends on:** Plan 1 deployed first (AppSync + `/reviewlensai/appsync/*`, `/reviewlensai/amplify/url` must exist; the scraper reads them at CDK synth — spec §6).

---

## File structure

```
scraper/
  pyproject.toml                    # ruff + pytest + deps
  src/reviewlensai_scraper/
    __init__.py
    log.py                          # structured JSON logging (jobId per line)
    steam.py                        # appdetails + appreviews pagination (dedup/termination)
    appsync.py                      # x-api-key GraphQL: createJob / updateJob (conditional)
    validator.py                    # Validator Lambda handler
    scraper.py                      # Scraper Lambda handler
  tests/
    fixtures/appreviews_page1.json  appreviews_page2.json  appreviews_empty.json  appdetails.json
    test_steam.py  test_appsync.py  test_validator.py  test_scraper.py  conftest.py
  cdk/
    package.json  tsconfig.json  cdk.json
    bin/scraper.ts
    lib/scraper-stack.ts
  docs/API_CONTRACT.md
.github/workflows/scraper-deploy.yml
.claude/agents/phase1-pm.md
```

---

## Task 1: Scaffold the scraper package + capture real fixtures

**Files:**
- Create: `scraper/pyproject.toml`, `scraper/src/reviewlensai_scraper/__init__.py`, `scraper/tests/conftest.py`, and the four fixtures under `scraper/tests/fixtures/`

- [ ] **Step 1: Create `scraper/pyproject.toml`**

```toml
[project]
name = "reviewlensai-scraper"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["requests>=2.32", "boto3>=1.34"]

[project.optional-dependencies]
dev = ["pytest>=8.3", "ruff>=0.6", "responses>=0.25", "mypy>=1.11", "boto3-stubs[essential]>=1.34"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"
```

- [ ] **Step 2: Capture REAL Steam fixtures (spec §8: real, not synthesized)**

Run from repo root (these are the same endpoints validated during brainstorming):
```bash
mkdir -p scraper/tests/fixtures
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
# Use a small-review game to keep fixtures tiny; appId 2622380 is an example — pick any live game.
curl -s -A "$UA" "https://store.steampowered.com/api/appdetails?appids=413150&cc=us&l=english" -o scraper/tests/fixtures/appdetails.json
curl -s -A "$UA" "https://store.steampowered.com/appreviews/413150?json=1&num_per_page=100&filter=recent&language=all&purchase_type=all&cursor=*" -o scraper/tests/fixtures/appreviews_page1.json
```
Then **hand-trim** `appreviews_page1.json` to ~5 reviews and create:
- `appreviews_page2.json` — copy of page1 with a **different `cursor`** value and 5 *different* `recommendationid`s, plus **one duplicate** `recommendationid` from page1 (to exercise dedup).
- `appreviews_empty.json` — `{ "success": 1, "query_summary": { "num_reviews": 0 }, "cursor": "AoJ...", "reviews": [] }` (end-of-stream).

> Why hand-trim: keeps fixtures readable and lets tests assert exact counts. The captured structure is real; only the volume is reduced.

- [ ] **Step 3: Create `scraper/tests/conftest.py`**

```python
import json
from pathlib import Path
import pytest

FIX = Path(__file__).parent / "fixtures"

def load(name): return json.loads((FIX / name).read_text(encoding="utf-8"))

@pytest.fixture
def appdetails(): return load("appdetails.json")
@pytest.fixture
def reviews_page1(): return load("appreviews_page1.json")
@pytest.fixture
def reviews_page2(): return load("appreviews_page2.json")
@pytest.fixture
def reviews_empty(): return load("appreviews_empty.json")
```

- [ ] **Step 4: Verify the toolchain**

Run: `cd scraper && python -m pip install -e ".[dev]" && python -m pytest -q`
Expected: install succeeds; pytest reports "no tests ran" (0 tests). If fixtures fail to parse, re-capture.

- [ ] **Step 5: Commit**

```bash
git add scraper/pyproject.toml scraper/src/reviewlensai_scraper/__init__.py scraper/tests/conftest.py scraper/tests/fixtures
git commit -m "chore(scraper): scaffold Python package + real Steam fixtures"
```

---

## Task 2: Structured logging

**Files:**
- Create: `scraper/src/reviewlensai_scraper/log.py`
- Test: `scraper/tests/test_log.py`

- [ ] **Step 1: Write the failing test**

`scraper/tests/test_log.py`:
```python
import json
from reviewlensai_scraper.log import log_json

def test_log_json_emits_one_line(capsys):
    log_json("worker_start", job_id="j1", s3_keys=2)
    out = capsys.readouterr().out.strip()
    rec = json.loads(out)
    assert rec["event"] == "worker_start"
    assert rec["jobId"] == "j1"
    assert rec["s3Keys"] == 2
```

- [ ] **Step 2: Run to verify fail**

Run: `cd scraper && python -m pytest tests/test_log.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scraper/src/reviewlensai_scraper/log.py`**

```python
import json
import sys
from typing import Any

def _camel(s: str) -> str:
    head, *tail = s.split("_")
    return head + "".join(w.capitalize() for w in tail)

def log_json(event: str, **fields: Any) -> None:
    """Emit one structured JSON line (spec §4.3: jobId per line)."""
    rec = {"event": event}
    rec.update({_camel(k): v for k, v in fields.items()})
    sys.stdout.write(json.dumps(rec, default=str) + "\n")
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scraper && python -m pytest tests/test_log.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scraper/src/reviewlensai_scraper/log.py scraper/tests/test_log.py
git commit -m "feat(scraper): structured JSON logging helper"
```

---

## Task 3: Steam client — appdetails + appreviews pagination

**Files:**
- Create: `scraper/src/reviewlensai_scraper/steam.py`
- Test: `scraper/tests/test_steam.py`

Implements spec §4.1 step 2, §4.2 step 4: existence check, cursor pagination with **dedup by `recommendationid`**, **stop on empty/repeated-cursor/cap**, URL-encoded cursor, `query_summary` from page 1, field trimming.

- [ ] **Step 1: Write the failing tests**

`scraper/tests/test_steam.py`:
```python
import responses
from reviewlensai_scraper import steam

APPID = "413150"

@responses.activate
def test_fetch_appdetails_success(appdetails):
    responses.get(f"https://store.steampowered.com/api/appdetails", json=appdetails)
    ok, data = steam.fetch_appdetails(APPID)
    assert ok is True
    assert data["name"]  # has a name

@responses.activate
def test_fetch_appdetails_not_found():
    responses.get("https://store.steampowered.com/api/appdetails", json={APPID: {"success": False}})
    ok, data = steam.fetch_appdetails(APPID)
    assert ok is False and data is None

@responses.activate
def test_paginate_dedups_and_caps(reviews_page1, reviews_page2, reviews_empty):
    # page1 -> page2 (has 1 dup) -> empty
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_page1)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_page2)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_empty)
    result = steam.scrape_reviews(APPID, max_reviews=1000, delay_s=0)
    ids = [r["recommendationid"] for r in result.reviews]
    assert len(ids) == len(set(ids))                       # no dups
    assert result.total_reviews == reviews_page1["query_summary"]["total_reviews"]  # from page 1
    assert result.scraped == len(result.reviews)

@responses.activate
def test_paginate_respects_cap(reviews_page1):
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=reviews_page1)
    result = steam.scrape_reviews(APPID, max_reviews=2, delay_s=0)
    assert result.scraped == 2

@responses.activate
def test_paginate_stops_on_repeated_cursor(reviews_page1):
    # same cursor returned twice -> end of stream sentinel
    same = {**reviews_page1, "cursor": "SAMECURSOR"}
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=same)
    responses.get("https://store.steampowered.com/appreviews/" + APPID, json=same)
    result = steam.scrape_reviews(APPID, max_reviews=10_000, delay_s=0)
    # second identical cursor must terminate; reviews not double-counted
    ids = [r["recommendationid"] for r in result.reviews]
    assert len(ids) == len(set(ids))

def test_trim_review_keeps_only_contract_fields(reviews_page1):
    raw = reviews_page1["reviews"][0]
    t = steam.trim_review(raw)
    assert set(t.keys()) <= {
        "recommendationid", "language", "review", "timestamp_created", "timestamp_updated",
        "voted_up", "votes_up", "votes_funny", "steam_purchase", "received_for_free",
        "written_during_early_access", "author",
    }
    assert set(t["author"].keys()) <= {"playtime_at_review", "playtime_forever"}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd scraper && python -m pytest tests/test_steam.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scraper/src/reviewlensai_scraper/steam.py`**

```python
from __future__ import annotations
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote
import requests

UA = "ReviewLensAI/1.0 (+https://github.com/NicholasACTran/reviewlensai)"
BASE = "https://store.steampowered.com"
TIMEOUT = 15

class SteamError(Exception): ...
class SteamReviewsUnavailable(SteamError): ...  # success:false mid-scrape (spec §4.2)

@dataclass
class ScrapeResult:
    total_reviews: int
    total_positive: int
    reviews: list[dict[str, Any]] = field(default_factory=list)
    @property
    def scraped(self) -> int: return len(self.reviews)
    @property
    def pct_positive(self) -> float | None:
        return None if self.total_reviews == 0 else self.total_positive / self.total_reviews

def fetch_appdetails(app_id: str, cc: str = "us", lang: str = "english") -> tuple[bool, dict | None]:
    r = requests.get(f"{BASE}/api/appdetails", params={"appids": app_id, "cc": cc, "l": lang},
                     headers={"User-Agent": UA}, timeout=TIMEOUT)
    r.raise_for_status()
    node = r.json().get(app_id, {})
    if not node.get("success"):
        return False, None
    return True, node["data"]

_KEEP = ("recommendationid", "language", "review", "timestamp_created", "timestamp_updated",
         "voted_up", "votes_up", "votes_funny", "steam_purchase", "received_for_free",
         "written_during_early_access")
_KEEP_AUTHOR = ("playtime_at_review", "playtime_forever")

def trim_review(raw: dict[str, Any]) -> dict[str, Any]:
    out = {k: raw[k] for k in _KEEP if k in raw}
    author = raw.get("author", {})
    out["author"] = {k: author[k] for k in _KEEP_AUTHOR if k in author}
    return out

def scrape_reviews(app_id: str, max_reviews: int, delay_s: float = 0.75) -> ScrapeResult:
    seen: set[str] = set()
    result: ScrapeResult | None = None
    cursor = "*"
    while True:
        page = _get_reviews_page(app_id, cursor)
        if not page.get("success", 1):
            raise SteamReviewsUnavailable(f"appreviews success=false for {app_id}")
        if result is None:
            qs = page.get("query_summary", {})
            result = ScrapeResult(total_reviews=qs.get("total_reviews", 0), total_positive=qs.get("total_positive", 0))
        for raw in page.get("reviews", []):
            rid = str(raw.get("recommendationid"))
            if rid in seen:
                continue
            seen.add(rid)
            result.reviews.append(trim_review(raw))
            if len(result.reviews) >= max_reviews:
                return result
        next_cursor = page.get("cursor")
        if not page.get("reviews") or next_cursor is None or next_cursor == cursor:
            return result            # empty page OR repeated cursor = end of stream
        cursor = next_cursor
        if delay_s:
            time.sleep(delay_s)

def _get_reviews_page(app_id: str, cursor: str) -> dict[str, Any]:
    url = f"{BASE}/appreviews/{app_id}"
    params = {"json": "1", "num_per_page": "100", "filter": "recent",
              "language": "all", "purchase_type": "all", "cursor": quote(cursor, safe="")}
    last_exc: Exception | None = None
    for attempt in range(3):                       # spec §4.2: max 3 tries/page on 429/5xx
        try:
            r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=TIMEOUT)
            if r.status_code in (429, 500, 502, 503, 504):
                raise SteamError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, SteamError) as e:
            last_exc = e
            time.sleep(0.5 * (attempt + 1))
    raise SteamError(f"appreviews failed after retries: {last_exc}")
```
> Note: `quote(cursor)` then passing via `params` double-encodes; pass the pre-encoded cursor by building the query string directly OR pass the raw cursor to `params` (requests encodes once). Choose ONE: here, drop `quote(...)` and let `requests` encode — change `"cursor": quote(cursor, safe="")` to `"cursor": cursor`. Keep the test `test_paginate_stops_on_repeated_cursor` green either way.

- [ ] **Step 4: Apply the cursor-encoding fix and run**

Edit `steam.py`: change `"cursor": quote(cursor, safe="")` → `"cursor": cursor` (let `requests` encode once). Remove the now-unused `quote` import.

Run: `cd scraper && python -m pytest tests/test_steam.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scraper/src/reviewlensai_scraper/steam.py scraper/tests/test_steam.py
git commit -m "feat(scraper): Steam client (appdetails + paginated reviews w/ dedup/termination)"
```

---

## Task 4: AppSync client — conditional mutations over x-api-key

**Files:**
- Create: `scraper/src/reviewlensai_scraper/appsync.py`
- Test: `scraper/tests/test_appsync.py`

Implements spec §3 (x-api-key writes), §3.1 (conditional transitions; writer sends only owned fields), §4.2 retry policy.

- [ ] **Step 1: Write the failing tests**

`scraper/tests/test_appsync.py`:
```python
import responses
from reviewlensai_scraper.appsync import AppSyncClient

URL = "https://example.appsync-api.us-east-1.amazonaws.com/graphql"

def make(): return AppSyncClient(URL, "da2-key")

@responses.activate
def test_create_job_sends_api_key_and_pending():
    responses.post(URL, json={"data": {"createJob": {"id": "j1"}}})
    make().create_job(job_id="j1", steam_url="u", app_id="1", game_name="G", header_image=None, price="$5", expires_at=123)
    req = responses.calls[0].request
    assert req.headers["x-api-key"] == "da2-key"
    assert "createJob" in req.body.decode()
    assert '"status":"PENDING"' in req.body.decode().replace(" ", "")

@responses.activate
def test_transition_running_sends_condition():
    responses.post(URL, json={"data": {"updateJob": {"id": "j1", "status": "RUNNING"}}})
    make().transition_running("j1")
    body = responses.calls[0].request.body.decode().replace(" ", "")
    assert '"status":"RUNNING"' in body
    # condition guards on prior state PENDING (spec §3.1)
    assert "PENDING" in responses.calls[0].request.body.decode()

@responses.activate
def test_conditional_check_failed_is_noop_not_raise():
    responses.post(URL, json={"data": {"updateJob": None},
                              "errors": [{"errorType": "ConditionalCheckFailedException"}]})
    # guard miss must be a no-op (returns False), not an exception
    assert make().transition_running("j1") is False

@responses.activate
def test_retries_on_5xx_then_succeeds():
    responses.post(URL, status=502)
    responses.post(URL, json={"data": {"updateJob": {"id": "j1"}}})
    assert make().transition_failed("j1", "Scrape failed. Try again.") is True
    assert len(responses.calls) == 2
```

- [ ] **Step 2: Run to verify fail**

Run: `cd scraper && python -m pytest tests/test_appsync.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scraper/src/reviewlensai_scraper/appsync.py`**

```python
from __future__ import annotations
import time
from typing import Any
import requests
from .log import log_json

class AppSyncError(Exception): ...

_CREATE = """
mutation Create($input: CreateJobInput!) { createJob(input: $input) { id status } }
"""
_UPDATE = """
mutation Update($input: UpdateJobInput!, $cond: ModelJobConditionInput) {
  updateJob(input: $input, condition: $cond) { id status }
}
"""

class AppSyncClient:
    def __init__(self, url: str, api_key: str, timeout: int = 10):
        self.url, self.api_key, self.timeout = url, api_key, timeout

    def create_job(self, *, job_id, steam_url, app_id, game_name, header_image, price, expires_at) -> None:
        self._post(_CREATE, {"input": {
            "id": job_id, "status": "PENDING", "steamUrl": steam_url, "appId": app_id,
            "gameName": game_name, "headerImage": header_image, "price": price, "expiresAt": expires_at,
        }})

    def transition_running(self, job_id: str) -> bool:
        return self._update({"id": job_id, "status": "RUNNING"}, {"status": {"eq": "PENDING"}})

    def transition_succeeded(self, job_id, *, total_reviews, pct_positive, scraped_reviews, s3_key) -> bool:
        return self._update({"id": job_id, "status": "SUCCEEDED", "totalReviews": total_reviews,
                             "pctPositive": pct_positive, "scrapedReviews": scraped_reviews, "s3Key": s3_key},
                            {"status": {"eq": "RUNNING"}})

    def transition_failed(self, job_id: str, message: str, *, from_status: str = "RUNNING") -> bool:
        return self._update({"id": job_id, "status": "FAILED", "errorMessage": message},
                            {"status": {"eq": from_status}})

    def _update(self, input_: dict, cond: dict) -> bool:
        data, errors = self._post(_UPDATE, {"input": input_, "cond": cond}, tolerate_errors=True)
        if errors:
            if any("ConditionalCheckFailed" in (e.get("errorType", "") + e.get("message", "")) for e in errors):
                log_json("appsync_condition_noop", job_id=input_.get("id"))
                return False
            raise AppSyncError(str(errors))
        return True

    def _post(self, query: str, variables: dict, tolerate_errors: bool = False) -> Any:
        last: Exception | None = None
        for attempt in range(2):                      # spec §4.2: 1 retry on 5xx/network, 500ms backoff
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
                time.sleep(0.5)
        raise AppSyncError(f"AppSync call failed after retries: {last}")
```
> The `ModelJobConditionInput`/`CreateJobInput` names are the Amplify-generated GraphQL input types. Confirm exact names from the deployed schema during integration (Plan 1 generates them); adjust the query strings if Amplify pluralizes/namespaces differently.

- [ ] **Step 4: Run to verify pass**

Run: `cd scraper && python -m pytest tests/test_appsync.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scraper/src/reviewlensai_scraper/appsync.py scraper/tests/test_appsync.py
git commit -m "feat(scraper): AppSync x-api-key client w/ conditional transitions + retry"
```

---

## Task 5: Validator Lambda handler

**Files:**
- Create: `scraper/src/reviewlensai_scraper/validator.py`
- Test: `scraper/tests/test_validator.py`

Implements spec §4.1 + §7 channel ①: shape check, existence check, createJob(PENDING), async-invoke (passing appdetails), invoke-failure → guarded `PENDING→FAILED`, CORS.

- [ ] **Step 1: Write the failing tests**

`scraper/tests/test_validator.py`:
```python
import json
from unittest.mock import MagicMock
import pytest
from reviewlensai_scraper import validator

def event(url): return {"body": json.dumps({"url": url}), "requestContext": {"http": {"method": "POST"}}}

@pytest.fixture
def deps(monkeypatch):
    appsync = MagicMock()
    lam = MagicMock()
    monkeypatch.setattr(validator, "_appsync", lambda: appsync)
    monkeypatch.setattr(validator, "_lambda", lambda: lam)
    monkeypatch.setattr(validator, "ALLOWED_ORIGIN", "https://app.example")
    return appsync, lam

def test_rejects_non_steam_url(deps):
    res = validator.handler(event("https://google.com"), None)
    assert res["statusCode"] == 400
    assert "Steam game URL" in json.loads(res["body"])["error"]

def test_rejects_when_appdetails_missing(deps, monkeypatch):
    monkeypatch.setattr(validator.steam, "fetch_appdetails", lambda app_id, **k: (False, None))
    res = validator.handler(event("https://store.steampowered.com/app/999/"), None)
    assert res["statusCode"] == 400
    assert "couldn't find" in json.loads(res["body"])["error"].lower()

def test_happy_path_creates_job_and_invokes(deps, monkeypatch, appdetails):
    appsync, lam = deps
    monkeypatch.setattr(validator.steam, "fetch_appdetails", lambda app_id, **k: (True, appdetails))
    res = validator.handler(event("https://store.steampowered.com/app/413150/Foo/"), None)
    assert res["statusCode"] == 200
    job_id = json.loads(res["body"])["jobId"]
    appsync.create_job.assert_called_once()
    assert appsync.create_job.call_args.kwargs["app_id"] == "413150"
    lam.invoke.assert_called_once()
    payload = json.loads(lam.invoke.call_args.kwargs["Payload"])
    assert payload["jobId"] == job_id and payload["appId"] == "413150"
    assert "appdetails" in payload                       # passes payload (spec §4.1 step 4)

def test_invoke_failure_marks_failed_but_returns_jobid(deps, monkeypatch, appdetails):
    appsync, lam = deps
    monkeypatch.setattr(validator.steam, "fetch_appdetails", lambda app_id, **k: (True, appdetails))
    lam.invoke.side_effect = RuntimeError("throttled")
    res = validator.handler(event("https://store.steampowered.com/app/413150/"), None)
    assert res["statusCode"] == 200                       # still returns jobId
    appsync.transition_failed.assert_called_once()
    assert appsync.transition_failed.call_args.kwargs.get("from_status") == "PENDING"
```

- [ ] **Step 2: Run to verify fail**

Run: `cd scraper && python -m pytest tests/test_validator.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scraper/src/reviewlensai_scraper/validator.py`**

```python
from __future__ import annotations
import json
import os
import re
import time
import uuid
from urllib.parse import urlparse
import boto3
from . import steam
from .appsync import AppSyncClient
from .log import log_json

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
SCRAPER_FN = os.environ.get("SCRAPER_FUNCTION_NAME", "")
TTL_DAYS = 30
_APP_RE = re.compile(r"^/app/(\d+)")

def _appsync() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])
def _lambda():
    return boto3.client("lambda")

def _resp(status: int, body: dict) -> dict:
    return {"statusCode": status, "headers": {
        "content-type": "application/json",
        "access-control-allow-origin": ALLOWED_ORIGIN,
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type",
    }, "body": json.dumps(body)}

def _parse_app_id(url: str) -> str | None:
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or u.netloc != "store.steampowered.com":
        return None
    m = _APP_RE.match(u.path)
    return m.group(1) if m else None

def handler(event: dict, _context) -> dict:
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "OPTIONS":
        return _resp(204, {})
    try:
        url = (json.loads(event.get("body") or "{}")).get("url", "")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Enter a valid URL."})

    app_id = _parse_app_id(url)
    if not app_id:
        return _resp(400, {"error": "That's not a Steam game URL."})

    try:
        ok, details = steam.fetch_appdetails(app_id)
    except Exception:  # network/HTTP — treat as not found for the user (spec §4.1)
        ok, details = False, None
    if not ok or details is None:
        return _resp(400, {"error": "We couldn't find that game on Steam."})

    job_id = str(uuid.uuid4())
    appsync = _appsync()
    price = (details.get("price_overview") or {}).get("final_formatted")
    appsync.create_job(job_id=job_id, steam_url=url, app_id=app_id,
                       game_name=details.get("name"), header_image=details.get("header_image"),
                       price=price, expires_at=int(time.time()) + TTL_DAYS * 86400)
    log_json("validator_created", job_id=job_id, app_id=app_id)

    try:
        _lambda().invoke(FunctionName=SCRAPER_FN, InvocationType="Event",
                         Payload=json.dumps({"jobId": job_id, "appId": app_id, "appdetails": details}).encode())
    except Exception as e:  # spec §4.1 step 5: guarded PENDING->FAILED, still return jobId
        log_json("validator_invoke_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't start the scrape. Try again.", from_status="PENDING")

    return _resp(200, {"jobId": job_id})
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scraper && python -m pytest tests/test_validator.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scraper/src/reviewlensai_scraper/validator.py scraper/tests/test_validator.py
git commit -m "feat(scraper): Validator Lambda (validate, createJob, async-invoke, invoke-fail guard)"
```

---

## Task 6: Scraper Lambda handler

**Files:**
- Create: `scraper/src/reviewlensai_scraper/scraper.py`
- Test: `scraper/tests/test_scraper.py`

Implements spec §4.2 + §7 channel ②: PENDING→RUNNING guard, use passed appdetails, scrape, S3 write, SUCCEEDED, ScrapeSucceeded emit (non-fatal), error taxonomy, zero-review SUCCEEDED, success:false branch.

- [ ] **Step 1: Write the failing tests**

`scraper/tests/test_scraper.py`:
```python
from unittest.mock import MagicMock
import json
import pytest
from reviewlensai_scraper import scraper, steam

@pytest.fixture
def deps(monkeypatch):
    appsync, s3, events = MagicMock(), MagicMock(), MagicMock()
    appsync.transition_running.return_value = True
    monkeypatch.setattr(scraper, "_appsync", lambda: appsync)
    monkeypatch.setattr(scraper, "_s3", lambda: s3)
    monkeypatch.setattr(scraper, "_events", lambda: events)
    monkeypatch.setenv("S3_BUCKET", "bucket")
    monkeypatch.setenv("EVENT_BUS_NAME", "reviewlensai")
    monkeypatch.setenv("MAX_REVIEWS", "10000")
    return appsync, s3, events

def evt(details=None): return {"jobId": "j1", "appId": "413150", "appdetails": details or {"name": "Foo"}}

def test_guard_miss_is_noop(deps, monkeypatch):
    appsync, s3, _ = deps
    appsync.transition_running.return_value = False   # duplicate delivery
    scraper.handler(evt(), None)
    s3.put_object.assert_not_called()
    appsync.transition_succeeded.assert_not_called()

def test_happy_path_writes_s3_and_succeeds_and_emits(deps, monkeypatch):
    appsync, s3, events = deps
    monkeypatch.setattr(scraper.steam, "scrape_reviews",
        lambda app_id, max_reviews, **k: steam.ScrapeResult(100, 90, [{"recommendationid": "1"}]))
    scraper.handler(evt(), None)
    s3.put_object.assert_called_once()
    key = s3.put_object.call_args.kwargs["Key"]
    assert key == "jobs/j1/413150.json"
    appsync.transition_succeeded.assert_called_once()
    kw = appsync.transition_succeeded.call_args.kwargs
    assert kw["total_reviews"] == 100 and kw["scraped_reviews"] == 1 and kw["pct_positive"] == 0.9
    events.put_events.assert_called_once()             # ScrapeSucceeded

def test_zero_reviews_is_succeeded_with_null_pct(deps, monkeypatch):
    appsync, s3, _ = deps
    monkeypatch.setattr(scraper.steam, "scrape_reviews",
        lambda app_id, max_reviews, **k: steam.ScrapeResult(0, 0, []))
    scraper.handler(evt(), None)
    assert appsync.transition_succeeded.call_args.kwargs["pct_positive"] is None

def test_reviews_unavailable_maps_to_failed(deps, monkeypatch):
    appsync, _, _ = deps
    monkeypatch.setattr(scraper.steam, "scrape_reviews",
        lambda app_id, max_reviews, **k: (_ for _ in ()).throw(steam.SteamReviewsUnavailable("x")))
    scraper.handler(evt(), None)
    appsync.transition_failed.assert_called_once()
    assert appsync.transition_failed.call_args.args[1] == "Couldn't read Steam reviews. Try again."

def test_emit_failure_is_nonfatal(deps, monkeypatch):
    appsync, s3, events = deps
    events.put_events.side_effect = RuntimeError("eventbridge down")
    monkeypatch.setattr(scraper.steam, "scrape_reviews",
        lambda app_id, max_reviews, **k: steam.ScrapeResult(1, 1, [{"recommendationid": "1"}]))
    scraper.handler(evt(), None)                        # must not raise
    appsync.transition_succeeded.assert_called_once()
```

- [ ] **Step 2: Run to verify fail**

Run: `cd scraper && python -m pytest tests/test_scraper.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scraper/src/reviewlensai_scraper/scraper.py`**

```python
from __future__ import annotations
import json
import os
import boto3
from . import steam
from .appsync import AppSyncClient
from .log import log_json

def _appsync() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])
def _s3(): return boto3.client("s3")
def _events(): return boto3.client("events")

def _build_metadata(details: dict) -> dict:
    return {
        "name": details.get("name"), "shortDescription": details.get("short_description"),
        "aboutTheGame": details.get("about_the_game"), "genres": details.get("genres"),
        "categories": details.get("categories"), "price": (details.get("price_overview") or {}).get("final_formatted"),
        "headerImage": details.get("header_image"), "releaseDate": details.get("release_date"),
    }

def handler(event: dict, _context) -> None:
    job_id = event["jobId"]; app_id = event["appId"]; details = event.get("appdetails") or {}
    appsync = _appsync()
    if not appsync.transition_running(job_id):            # spec §3.1 PENDING->RUNNING guard
        log_json("scraper_guard_noop", job_id=job_id)
        return
    log_json("worker_start", job_id=job_id, app_id=app_id)
    try:
        max_reviews = int(os.environ.get("MAX_REVIEWS", "10000"))
        result = steam.scrape_reviews(app_id, max_reviews=max_reviews)
        payload = {"game": _build_metadata(details),
                   "summary": {"totalReviews": result.total_reviews, "totalPositive": result.total_positive,
                               "pctPositive": result.pct_positive},
                   "reviews": result.reviews}
        s3_key = f"jobs/{job_id}/{app_id}.json"
        _s3().put_object(Bucket=os.environ["S3_BUCKET"], Key=s3_key,
                         Body=json.dumps(payload).encode(), ContentType="application/json")
        log_json("worker_s3_written", job_id=job_id, s3_key=s3_key, scraped=result.scraped)
        appsync.transition_succeeded(job_id, total_reviews=result.total_reviews,
                                     pct_positive=result.pct_positive, scraped_reviews=result.scraped, s3_key=s3_key)
        _emit_succeeded(job_id, app_id, s3_key)
        log_json("worker_complete", job_id=job_id)
    except steam.SteamReviewsUnavailable as e:
        log_json("worker_reviews_unavailable", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't read Steam reviews. Try again.")
    except steam.SteamError as e:
        log_json("worker_steam_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't reach Steam. Try again.")
    except Exception as e:
        log_json("worker_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Scrape failed. Try again.")

def _emit_succeeded(job_id: str, app_id: str, s3_key: str) -> None:
    try:                                                  # spec §4.2 step 7: NON-FATAL
        _events().put_events(Entries=[{
            "Source": "reviewlensai.scraper", "DetailType": "ScrapeSucceeded",
            "EventBusName": os.environ["EVENT_BUS_NAME"],
            "Detail": json.dumps({"jobId": job_id, "appId": app_id, "s3Key": s3_key}),
        }])
    except Exception as e:
        log_json("worker_emit_failed", job_id=job_id, error=str(e))
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scraper && python -m pytest tests/test_scraper.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite + lint**

Run: `cd scraper && python -m pytest -q && ruff check src tests`
Expected: all tests PASS; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add scraper/src/reviewlensai_scraper/scraper.py scraper/tests/test_scraper.py
git commit -m "feat(scraper): Scraper Lambda (guard, scrape, S3, SUCCEEDED, non-fatal emit, taxonomy)"
```

---

## Task 7: CDK stack

**Files:**
- Create: `scraper/cdk/package.json`, `tsconfig.json`, `cdk.json`, `bin/scraper.ts`, `lib/scraper-stack.ts`
- Test: `scraper/cdk/test/scraper-stack.test.ts`

Implements spec §4.4 + §6: two Lambdas, Function URL, DLQ + async config (retries 0) + reserved concurrency 3, S3 (+lifecycle), custom bus + SSM export, alarms, IAM, SSM reads.

- [ ] **Step 1: Create CDK project files**

`scraper/cdk/package.json`:
```json
{
  "name": "reviewlensai-scraper-cdk",
  "scripts": { "build": "tsc", "test": "jest", "cdk": "cdk", "synth": "cdk synth" },
  "devDependencies": {
    "@types/jest": "^29.5.12", "@types/node": "^20.14.0", "aws-cdk": "^2.150.0",
    "jest": "^29.7.0", "ts-jest": "^29.2.0", "typescript": "^5.5.4"
  },
  "dependencies": { "aws-cdk-lib": "^2.150.0", "constructs": "^10.3.0" }
}
```

`scraper/cdk/cdk.json`: `{ "app": "npx ts-node --prefer-ts-exts bin/scraper.ts" }`
`scraper/cdk/tsconfig.json`: standard CDK tsconfig (target ES2021, module commonjs, strict true).
`scraper/cdk/test/jest.config.js` or `package.json` jest stanza: `ts-jest` preset, `testEnvironment: node`.

- [ ] **Step 2: Write the failing stack test**

`scraper/cdk/test/scraper-stack.test.ts`:
```ts
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ScraperStack } from "../lib/scraper-stack";

function synth() {
  const app = new App({ context: { appsyncUrl: "https://x/graphql", appsyncApiKey: "k", amplifyUrl: "https://app.example" } });
  return Template.fromStack(new ScraperStack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } }));
}

test("creates two Lambda functions", () => {
  synth().resourceCountIs("AWS::Lambda::Function", 2);
});
test("scraper has reserved concurrency 3 and a DLQ", () => {
  const t = synth();
  t.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 3 });
  t.resourceCountIs("AWS::SQS::Queue", 1);
});
test("validator has a public Function URL", () => {
  synth().hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
});
test("custom event bus + DLQ alarm exist", () => {
  const t = synth();
  t.resourceCountIs("AWS::Events::EventBus", 1);
  t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
});
test("S3 bucket blocks public access and has a lifecycle rule", () => {
  const t = synth();
  t.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true },
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd scraper/cdk && npm install && npm test`
Expected: FAIL — `../lib/scraper-stack` missing.

- [ ] **Step 4: Write `scraper/cdk/lib/scraper-stack.ts`**

```ts
import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { FunctionUrlAuthType, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { EventInvokeConfig } from "aws-cdk-lib/aws-lambda";

export class ScraperStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Cross-domain inputs (spec §6) — read at synth from SSM (context override in tests).
    const appsyncUrl = this.node.tryGetContext("appsyncUrl")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/url");
    const appsyncApiKey = this.node.tryGetContext("appsyncApiKey")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/apiKey");
    const amplifyUrl = this.node.tryGetContext("amplifyUrl")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/amplify/url");

    const bucket = new s3.Bucket(this, "ScrapeBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ prefix: "jobs/", expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    const bus = new events.EventBus(this, "ReviewLensBus", { eventBusName: "reviewlensai" });

    const dlq = new sqs.Queue(this, "ScraperDlq", { retentionPeriod: Duration.days(14) });

    const code = Code.fromAsset("../src");  // packages reviewlensai_scraper; deps via layer/bundling in CI
    const commonEnv = { APPSYNC_URL: appsyncUrl, APPSYNC_API_KEY: appsyncApiKey };

    const scraperFn = new lambda.Function(this, "ScraperFn", {
      runtime: Runtime.PYTHON_3_12, handler: "reviewlensai_scraper.scraper.handler", code,
      timeout: Duration.seconds(600), memorySize: 1024, reservedConcurrentExecutions: 3,
      environment: { ...commonEnv, S3_BUCKET: bucket.bucketName, EVENT_BUS_NAME: bus.eventBusName, MAX_REVIEWS: "10000" },
    });
    new EventInvokeConfig(this, "ScraperAsyncCfg", {
      function: scraperFn, retryAttempts: 0, onFailure: { bind: () => ({ destination: dlq.queueArn }) } as any,
    });
    bucket.grantPut(scraperFn);
    bus.grantPutEventsTo(scraperFn);

    const validatorFn = new lambda.Function(this, "ValidatorFn", {
      runtime: Runtime.PYTHON_3_12, handler: "reviewlensai_scraper.validator.handler", code,
      timeout: Duration.seconds(10), memorySize: 256,
      environment: { ...commonEnv, ALLOWED_ORIGIN: amplifyUrl, SCRAPER_FUNCTION_NAME: scraperFn.functionName },
    });
    scraperFn.grantInvoke(validatorFn);

    const url = validatorFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: { allowedOrigins: [amplifyUrl], allowedMethods: [lambda.HttpMethod.POST] },
    });

    // Alarms (spec §4.4): DLQ depth + scraper errors.
    new cw.Alarm(this, "DlqDepthAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    new cw.Alarm(this, "ScraperErrorsAlarm", {
      metric: scraperFn.metricErrors(), threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Outputs back to the contract (spec §6).
    new ssm.StringParameter(this, "EventBusNameParam", {
      parameterName: "/reviewlensai/scraper/eventBusName", stringValue: bus.eventBusName,
    });
    new ssm.StringParameter(this, "ValidatorUrlParam", {
      parameterName: "/reviewlensai/scraper/validatorUrl", stringValue: url.url,
    });
  }
}
```
> The `EventInvokeConfig` `onFailure` accessor is illustrative — use `aws-cdk-lib/aws-lambda-destinations` `SqsDestination(dlq)` with `scraperFn.configureAsyncInvoke({ retryAttempts: 0, onFailure: new SqsDestination(dlq) })` for the real, type-clean API. Replace the `EventInvokeConfig` block with that during implementation; the test only checks retries/DLQ existence.

- [ ] **Step 5: Apply the destinations fix, write `bin/scraper.ts`, run tests**

`scraper/cdk/bin/scraper.ts`:
```ts
#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ScraperStack } from "../lib/scraper-stack";
const app = new App();
new ScraperStack(app, "ReviewLensScraperStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
```

Replace the async-invoke block in `scraper-stack.ts`:
```ts
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
// ...
scraperFn.configureAsyncInvoke({ retryAttempts: 0, onFailure: new SqsDestination(dlq) });
```

Run: `cd scraper/cdk && npm test`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add scraper/cdk
git commit -m "feat(scraper): CDK stack (2 Lambdas, FnURL, DLQ, reserved concurrency, bus, alarms, SSM)"
```

---

## Task 8: API contract doc, deploy workflow, PM agent

**Files:**
- Create: `scraper/docs/API_CONTRACT.md`, `.github/workflows/scraper-deploy.yml`, `.claude/agents/phase1-pm.md`

- [ ] **Step 1: Write `scraper/docs/API_CONTRACT.md`** (spec §9 deliverable)

Document: the Validator Function URL request/response (POST `{url}` → `200 {jobId}` | `4xx {error}`); the full `Job` field table + ownership (copy from spec §3/§3.1); and the `ScrapeSucceeded` event schema (`Source`, `DetailType`, `Detail: {jobId, appId, s3Key}` on bus `reviewlensai`). This is the canonical artifact Phase 2/3 consume.

- [ ] **Step 2: Write `.github/workflows/scraper-deploy.yml`**

```yaml
name: scraper-deploy
on:
  push:
    branches: [main]
    paths: ["scraper/**", ".github/workflows/scraper-deploy.yml"]
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Unit tests + lint
        working-directory: scraper
        run: |
          python -m pip install -e ".[dev]"
          python -m pytest -q
          ruff check src tests
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: "${{ secrets.AWS_DEPLOY_ROLE_ARN }}", aws-region: us-east-1 }
      - name: CDK deploy (reads app SSM params at synth — app must be deployed first)
        working-directory: scraper/cdk
        run: |
          npm ci
          # bundle python deps into the asset (requests/boto3 provided by runtime; vendor requests)
          pip install requests -t ../src
          npx cdk deploy --require-approval never
      - name: Feed Validator URL back to the app (spec §6 step 3)
        run: |
          VURL=$(aws ssm get-parameter --name /reviewlensai/scraper/validatorUrl --query Parameter.Value --output text)
          aws amplify update-branch --app-id ${{ secrets.AMPLIFY_APP_ID }} --branch-name main \
            --environment-variables VITE_VALIDATOR_URL=$VURL
          aws amplify start-job --app-id ${{ secrets.AMPLIFY_APP_ID }} --branch-name main --job-type RELEASE
```
> `boto3` is in the Lambda runtime; `requests` must be vendored into the asset (the `pip install requests -t ../src` step). Confirm the asset path matches `Code.fromAsset("../src")`.

- [ ] **Step 3: Write `.claude/agents/phase1-pm.md`** (spec §8 E2E)

A Playwright-driven PM agent definition that: opens the staging Amplify URL (from `/reviewlensai/amplify/url`), pastes a known-good Steam URL, asserts the waiting screen then the nominal screen (name/#reviews/%positive), then tests an invalid URL (inline error) and a forced-failure path; **and tails the Scraper logs + polls the Job row** alongside the browser so FE-vs-backend latency is separable (the project's validation-observability practice). Screenshots → top-level `screenshots/`.

- [ ] **Step 4: Verify docs/workflows are well-formed**

Run: `cd scraper && python -m pytest -q && ruff check src tests` and `cd scraper/cdk && npm test`
Expected: all green (this task adds no code paths; re-running guards against regressions).

- [ ] **Step 5: Commit**

```bash
git add scraper/docs/API_CONTRACT.md .github/workflows/scraper-deploy.yml .claude/agents/phase1-pm.md
git commit -m "docs(scraper): API contract + deploy workflow + Playwright PM agent"
```

---

## Self-review (completed by plan author)

- **Spec §4.1 Validator:** Task 5 (shape/existence/create/invoke/invoke-fail guard, CORS). ✓
- **Spec §4.2 Scraper:** Task 6 (guard, passed-appdetails, scrape, S3, SUCCEEDED, non-fatal emit, taxonomy, zero-review, success:false). ✓
- **Spec §4.2 pagination details:** Task 3 (dedup, stop conditions, single-encode cursor, query_summary page-1, trim). ✓
- **Spec §3/§3.1 writes:** Task 4 (x-api-key, conditional transitions, owned-fields-only, ConditionalCheckFailed=no-op, retry). ✓
- **Spec §4.4 infra + §6 SSM:** Task 7 (2 Lambdas, FnURL NONE, DLQ+retries 0, reserved concurrency 3, bucket+lifecycle, custom bus, 2 alarms, SSM read/write, IAM grants). ✓
- **Spec §9 deliverables:** Task 8 (API_CONTRACT.md, deploy workflow, VITE_VALIDATOR_URL feedback, PM agent). ✓
- **Spec §8 fixtures are real:** Task 1 Step 2 captures live Steam JSON. ✓
- **Implementation risks flagged inline:** exact Amplify GraphQL input-type names (Task 4 Step 3), the `configureAsyncInvoke`/destinations API (Task 7 Step 4–5), and vendoring `requests` into the asset (Task 8 Step 2) — each noted at its step for verification during execution.
