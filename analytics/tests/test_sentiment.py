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
