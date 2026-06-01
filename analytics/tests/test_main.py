import json
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
