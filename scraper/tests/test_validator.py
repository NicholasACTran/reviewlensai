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
    assert lam.invoke.call_args.kwargs["InvocationType"] == "Event"   # async, not sync
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
