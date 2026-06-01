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

    def key(r: dict[str, Any]) -> tuple[int, int, int]:
        return (int(r.get("votes_up", 0)), int(r.get("votes_funny", 0)), int(r.get("timestamp_created", 0)))

    pos = sorted([r for r in eligible if r.get("voted_up")], key=key, reverse=True)[:3]
    neg = sorted([r for r in eligible if not r.get("voted_up")], key=key, reverse=True)[:3]
    return [_shape(r) for r in pos], [_shape(r) for r in neg]
