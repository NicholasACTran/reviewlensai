from __future__ import annotations
import json
import os
import re
import time
import uuid
from urllib.parse import urlparse
import boto3
from . import steam
from .appsync import AppSyncClient
from .log import log_json

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
SCRAPER_FN = os.environ.get("SCRAPER_FUNCTION_NAME", "")
TTL_DAYS = 30
_APP_RE = re.compile(r"^/app/(\d+)")

def _appsync() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])
def _lambda():
    return boto3.client("lambda")

def _resp(status: int, body: dict) -> dict:
    # CORS is owned entirely by the Function URL CORS config. Setting CORS headers here too would
    # produce DUPLICATE access-control-allow-origin headers, which browsers reject. Only set
    # content-type here. (ALLOWED_ORIGIN env is retained for reference/tests but not echoed.)
    return {"statusCode": status, "headers": {"content-type": "application/json"},
            "body": json.dumps(body)}

def _parse_app_id(url: str) -> str | None:
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or u.netloc != "store.steampowered.com":
        return None
    m = _APP_RE.match(u.path)
    return m.group(1) if m else None

def handler(event: dict, _context) -> dict:
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "OPTIONS":
        return _resp(204, {})
    try:
        url = (json.loads(event.get("body") or "{}")).get("url", "")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Enter a valid URL."})

    app_id = _parse_app_id(url)
    if not app_id:
        return _resp(400, {"error": "That's not a Steam game URL."})

    try:
        ok, details = steam.fetch_appdetails(app_id)
    except Exception:  # network/HTTP — treat as not found for the user (spec §4.1)
        ok, details = False, None
    if not ok or details is None:
        return _resp(400, {"error": "We couldn't find that game on Steam."})

    job_id = str(uuid.uuid4())
    appsync = _appsync()
    price = (details.get("price_overview") or {}).get("final_formatted")
    try:
        appsync.create_job(job_id=job_id, steam_url=url, app_id=app_id,
                           game_name=details.get("name"), header_image=details.get("header_image"),
                           price=price, expires_at=int(time.time()) + TTL_DAYS * 86400)
    except Exception as e:  # AppSync down / expired key — return a CORS-headed, taxonomy-consistent error
        log_json("validator_create_failed", job_id=job_id, error=str(e))
        return _resp(500, {"error": "Couldn't start the scrape. Try again."})
    log_json("validator_created", job_id=job_id, app_id=app_id)

    try:
        _lambda().invoke(FunctionName=SCRAPER_FN, InvocationType="Event",
                         Payload=json.dumps({"jobId": job_id, "appId": app_id, "appdetails": details}).encode())
    except Exception as e:  # spec §4.1 step 5: guarded PENDING->FAILED, still return jobId
        log_json("validator_invoke_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't start the scrape. Try again.", from_status="PENDING")

    return _resp(200, {"jobId": job_id})
