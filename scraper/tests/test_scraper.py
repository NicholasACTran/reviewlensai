from unittest.mock import MagicMock
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
