from __future__ import annotations
import json
import os
from typing import Any
import boto3
from .appsync import AppSyncClient
from .errors import S3ReadError
from .payload import build_payload
from .s3io import read_scrape_json
from .log import log_json

_S3 = boto3.client("s3")


def _client() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])


def _read_doc(key: str) -> dict[str, Any]:
    return read_scrape_json(_S3, os.environ["S3_BUCKET"], key)


def _write_terminal(client: AppSyncClient, job_id: str, status: str, **kw: Any) -> dict[str, Any]:
    """Terminal SUCCEEDED/FAILED write (guarded on RUNNING). On a write EXCEPTION,
    emit worker_failed_terminal_write_failed and re-raise → non-zero exit → DLQ (spec §8)."""
    try:
        if not client.update_analytics(job_id, status=status, **kw):
            log_json(
                "worker_failed_terminal_write_failed",
                job_id=job_id,
                status=status,
                reason="guard_miss",
            )
    except Exception as e:  # noqa: BLE001
        log_json(
            "worker_failed_terminal_write_failed", job_id=job_id, status=status, error=str(e)
        )
        raise
    return {"status": status}


def handler(event: dict[str, Any], _ctx: Any) -> dict[str, Any]:
    detail = (event or {}).get("detail") or {}
    job_id, s3_key = detail.get("jobId"), detail.get("s3Key")
    log_json("worker_invoked", job_id=job_id)
    if not job_id or not s3_key:
        log_json("worker_skipped", reason="no_jobid")
        return {"skipped": "no_jobid"}

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
    res["hasData"] = payload["hasData"]
    return res
