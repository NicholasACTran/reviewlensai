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
