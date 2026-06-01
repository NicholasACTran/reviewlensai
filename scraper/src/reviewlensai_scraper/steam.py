from __future__ import annotations
import time
from dataclasses import dataclass, field
from typing import Any
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

def fetch_review_summary(app_id: str) -> tuple[int, int]:
    """Totals come from a DEDICATED summary request. With `filter=recent` Steam does NOT
    populate query_summary.total_reviews/total_positive; `filter=all&num_per_page=0` does."""
    body = _request_reviews(app_id, {"num_per_page": "0", "filter": "all"})
    qs = body.get("query_summary", {})
    return qs.get("total_reviews", 0), qs.get("total_positive", 0)

def scrape_reviews(app_id: str, max_reviews: int, delay_s: float = 0.75) -> ScrapeResult:
    total_reviews, total_positive = fetch_review_summary(app_id)   # totals (filter=all)
    result = ScrapeResult(total_reviews=total_reviews, total_positive=total_positive)
    seen: set[str] = set()
    cursor = "*"
    while True:                                                    # bodies (filter=recent)
        page = _request_reviews(app_id, {"num_per_page": "100", "filter": "recent", "cursor": cursor})
        if not page.get("success", 1):
            raise SteamReviewsUnavailable(f"appreviews success=false for {app_id}")
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

def _request_reviews(app_id: str, extra: dict[str, str]) -> dict[str, Any]:
    """GET /appreviews with retry on 429/5xx. `requests` URL-encodes params once (incl. cursor)."""
    url = f"{BASE}/appreviews/{app_id}"
    params = {"json": "1", "language": "all", "purchase_type": "all", **extra}
    last_exc: Exception | None = None
    for attempt in range(3):                       # spec §4.2: max 3 tries on 429/5xx
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
