from __future__ import annotations
import json
import os
import boto3
from . import steam
from .appsync import AppSyncClient
from .log import log_json

def _appsync() -> AppSyncClient:
    return AppSyncClient(os.environ["APPSYNC_URL"], os.environ["APPSYNC_API_KEY"])
def _s3(): return boto3.client("s3")
def _events(): return boto3.client("events")

def _build_metadata(details: dict) -> dict:
    return {
        "name": details.get("name"), "shortDescription": details.get("short_description"),
        "aboutTheGame": details.get("about_the_game"), "genres": details.get("genres"),
        "categories": details.get("categories"), "price": (details.get("price_overview") or {}).get("final_formatted"),
        "headerImage": details.get("header_image"), "releaseDate": details.get("release_date"),
    }

def handler(event: dict, _context) -> None:
    job_id = event["jobId"]
    app_id = event["appId"]
    details = event.get("appdetails") or {}
    appsync = _appsync()
    if not appsync.transition_running(job_id):            # spec §3.1 PENDING->RUNNING guard
        log_json("scraper_guard_noop", job_id=job_id)
        return
    log_json("worker_start", job_id=job_id, app_id=app_id)
    try:
        max_reviews = int(os.environ.get("MAX_REVIEWS", "10000"))
        result = steam.scrape_reviews(app_id, max_reviews=max_reviews)
        payload = {"game": _build_metadata(details),
                   "summary": {"totalReviews": result.total_reviews, "totalPositive": result.total_positive,
                               "pctPositive": result.pct_positive},
                   "reviews": result.reviews}
        s3_key = f"jobs/{job_id}/{app_id}.json"
        _s3().put_object(Bucket=os.environ["S3_BUCKET"], Key=s3_key,
                         Body=json.dumps(payload).encode(), ContentType="application/json")
        log_json("worker_s3_written", job_id=job_id, s3_key=s3_key, scraped=result.scraped)
        appsync.transition_succeeded(job_id, total_reviews=result.total_reviews,
                                     pct_positive=result.pct_positive, scraped_reviews=result.scraped, s3_key=s3_key)
        _emit_succeeded(job_id, app_id, s3_key)
        log_json("worker_complete", job_id=job_id)
    except steam.SteamReviewsUnavailable as e:
        log_json("worker_reviews_unavailable", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't read Steam reviews. Try again.")
    except steam.SteamError as e:
        log_json("worker_steam_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Couldn't reach Steam. Try again.")
    except Exception as e:
        log_json("worker_failed", job_id=job_id, error=str(e))
        appsync.transition_failed(job_id, "Scrape failed. Try again.")

def _emit_succeeded(job_id: str, app_id: str, s3_key: str) -> None:
    try:                                                  # spec §4.2 step 7: NON-FATAL
        _events().put_events(Entries=[{
            "Source": "reviewlensai.scraper", "DetailType": "ScrapeSucceeded",
            "EventBusName": os.environ["EVENT_BUS_NAME"],
            "Detail": json.dumps({"jobId": job_id, "appId": app_id, "s3Key": s3_key}),
        }])
    except Exception as e:
        log_json("worker_emit_failed", job_id=job_id, error=str(e))
