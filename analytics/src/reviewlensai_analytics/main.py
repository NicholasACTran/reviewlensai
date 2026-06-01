from __future__ import annotations
import json
import os
from typing import Any
import boto3
from .appsync import AppSyncClient, AppSyncError
from .errors import S3ReadError
from .payload import build_payload
from .s3io import read_scrape_json
from .log import log_json

_S3 = boto3.client("s3")
# Lazy: EventBridge is regional, so boto3.client("events") raises NoRegionError if
# created at import in a no-region env (the CI unit-test step, before AWS creds are
# configured). The Lambda runtime always has a region, so defer creation to first
# use. (s3 above tolerates no region; events does not.)
_EVENTS = None


def _events():
    global _EVENTS
    if _EVENTS is None:
        _EVENTS = boto3.client("events")
    return _EVENTS


def _emit_analytics_succeeded(job_id: str, s3_key: str) -> None:
    try:                                              # NON-FATAL
        _events().put_events(Entries=[{
            "Source": "reviewlensai.analytics",
            "DetailType": "AnalyticsSucceeded",
            "EventBusName": os.environ["EVENT_BUS_NAME"],
            "Detail": json.dumps({"jobId": job_id, "s3Key": s3_key}),
        }])
    except Exception as e:  # noqa: BLE001
        log_json("worker_emit_failed", job_id=job_id, error=str(e))


def _client() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])


def _read_doc(key: str) -> dict[str, Any]:
    return read_scrape_json(_S3, os.environ["S3_BUCKET"], key)


def _write_terminal(client: AppSyncClient, job_id: str, status: str, **kw: Any) -> dict[str, Any]:
    """Terminal SUCCEEDED/FAILED write (guarded on RUNNING). On a write EXCEPTION or a guard-miss,
    emit worker_failed_terminal_write_failed and re-raise → non-zero exit → DLQ (spec §8)."""
    try:
        if not client.update_analytics(job_id, status=status, **kw):
            log_json("worker_failed_terminal_write_failed", job_id=job_id, status=status, reason="guard_miss")
            raise AppSyncError(f"terminal {status} write lost its RUNNING guard")
    except Exception as e:  # noqa: BLE001
        if not isinstance(e, AppSyncError):
            log_json(
                "worker_failed_terminal_write_failed", job_id=job_id, status=status, error=str(e)
            )
        raise
    return {"status": status}


def handler(event: dict[str, Any], _ctx: Any) -> dict[str, Any]:
    detail = (event or {}).get("detail") or {}
    job_id, s3_key = detail.get("jobId"), detail.get("s3Key")
    log_json("worker_invoked", job_id=job_id)
    if not job_id:
        log_json("worker_skipped", reason="no_jobid")
        return {"skipped": "no_jobid"}
    if not s3_key:
        log_json("worker_skipped", reason="no_s3key", job_id=job_id)
        return {"skipped": "no_s3key"}

    client = _client()
    row = client.get_job(job_id)
    if not row:
        log_json("worker_skipped", reason="no_row", job_id=job_id)
        return {"skipped": "no_row"}
    if row.get("status") != "SUCCEEDED":
        log_json("worker_skipped", reason="not_succeeded", job_id=job_id)
        return {"skipped": "not_succeeded"}
    if row.get("analyticsStatus") is not None:
        log_json("worker_skipped", reason="already_started", job_id=job_id)
        return {"skipped": "already_started"}

    # Atomic idempotency gate: attribute_not_exists(analyticsStatus). Duplicate deliveries lose here.
    if not client.update_analytics(job_id, status="RUNNING", guard_not_started=True):
        log_json("worker_skipped", reason="lost_guard_race", job_id=job_id)
        return {"skipped": "lost_guard_race"}
    log_json("worker_running", job_id=job_id)

    try:
        doc = _read_doc(s3_key)
        payload = build_payload(doc)
    except S3ReadError as e:
        log_json("worker_s3_read_failed", job_id=job_id, error=str(e))
        return _write_terminal(client, job_id, "FAILED", error_message="Couldn't read scrape data.")
    except Exception as e:  # noqa: BLE001 — catch-all is the spec's error taxonomy (§8)
        log_json("worker_failed", job_id=job_id, error=str(e))
        return _write_terminal(client, job_id, "FAILED", error_message="Analytics failed.")
    # Compute succeeded → terminal SUCCEEDED write (separate from the compute try/except so a
    # SUCCEEDED-write failure is NOT re-caught and flipped to FAILED).
    log_json(
        "worker_empty" if not payload["hasData"] else "worker_complete",
        job_id=job_id,
        has_data=payload["hasData"],
        english=payload["englishReviewCount"],
    )
    res = _write_terminal(client, job_id, "SUCCEEDED", analytics_json=json.dumps(payload))
    _emit_analytics_succeeded(job_id, s3_key)
    res["hasData"] = payload["hasData"]
    return res
