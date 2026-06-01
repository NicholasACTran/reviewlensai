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
