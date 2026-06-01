import json
from unittest.mock import MagicMock
from reviewlensai_analytics import main


class FakeAS:
    def __init__(self, row):
        self.row = row
        self.updates = []

    def get_job(self, jid):
        return self.row

    def update_analytics(self, jid, **kw):
        self.updates.append(kw)
        # simulate attribute_not_exists winning once
        if kw.get("guard_not_started"):
            return self.row.get("analyticsStatus") is None
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
    monkeypatch.setattr(
        main,
        "_read_doc",
        lambda key: {"game": {"name": "G"}, "summary": {"totalReviews": 0}, "reviews": []},
    )
    main.handler(_event(), None)
    assert [u["status"] for u in fas.updates] == ["RUNNING", "SUCCEEDED"]
    assert json.loads(fas.updates[1]["analytics_json"])["hasData"] is False


def test_s3_failure_writes_failed_message(monkeypatch):
    from reviewlensai_analytics.errors import S3ReadError

    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})
    monkeypatch.setattr(main, "_client", lambda: fas)

    def boom(key):
        raise S3ReadError("x")

    monkeypatch.setattr(main, "_read_doc", boom)
    main.handler(_event(), None)
    assert fas.updates[-1]["status"] == "FAILED"
    assert fas.updates[-1]["error_message"] == "Couldn't read scrape data."


def test_terminal_write_exception_reraises_for_dlq(monkeypatch):
    import pytest

    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})

    def update(jid, **kw):
        if kw.get("guard_not_started"):
            return True  # win the RUNNING guard
        raise RuntimeError("appsync down")  # terminal SUCCEEDED write fails

    fas.update_analytics = update
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: {"reviews": []})
    with pytest.raises(RuntimeError):  # re-raised → non-zero exit → DLQ (spec §8)
        main.handler(_event(), None)


def test_terminal_write_guard_miss_reraises(monkeypatch):
    import pytest
    from reviewlensai_analytics.appsync import AppSyncError

    fas = FakeAS({"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None})

    def update(jid, **kw):
        if kw.get("guard_not_started"):
            return True  # win the RUNNING guard
        return False  # terminal SUCCEEDED write loses its RUNNING guard

    fas.update_analytics = update
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: {"reviews": []})
    with pytest.raises(AppSyncError):  # guard-miss raises → non-zero exit → DLQ (spec §8)
        main.handler(_event(), None)


def test_selectionset_carries_chat_fields():
    from reviewlensai_analytics.appsync import _FULL_JOB_FIELDS
    assert "chatStatus" in _FULL_JOB_FIELDS
    assert "chatErrorMessage" in _FULL_JOB_FIELDS


_HAPPY_ROW = {"id": "j1", "status": "SUCCEEDED", "s3Key": "k", "analyticsStatus": None}
_HAPPY_DOC = {"game": {"name": "G"}, "summary": {"totalReviews": 0}, "reviews": []}


def test_succeeded_emits_analytics_succeeded(monkeypatch):
    fas = FakeAS(_HAPPY_ROW.copy())
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: _HAPPY_DOC)
    monkeypatch.setenv("EVENT_BUS_NAME", "reviewlensai")
    events_mock = MagicMock()
    monkeypatch.setattr(main, "_EVENTS", events_mock)
    main.handler(_event(), None)
    events_mock.put_events.assert_called_once()
    entry = events_mock.put_events.call_args.kwargs["Entries"][0]
    assert entry["Source"] == "reviewlensai.analytics"
    assert entry["DetailType"] == "AnalyticsSucceeded"


def test_emit_failure_is_nonfatal(monkeypatch):
    fas = FakeAS(_HAPPY_ROW.copy())
    monkeypatch.setattr(main, "_client", lambda: fas)
    monkeypatch.setattr(main, "_read_doc", lambda key: _HAPPY_DOC)
    monkeypatch.setenv("EVENT_BUS_NAME", "reviewlensai")
    events_mock = MagicMock()
    events_mock.put_events.side_effect = RuntimeError("eventbridge down")
    monkeypatch.setattr(main, "_EVENTS", events_mock)
    res = main.handler(_event(), None)   # must NOT raise
    assert res["status"] == "SUCCEEDED"
