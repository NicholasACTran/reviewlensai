from __future__ import annotations
import time
from typing import Any
import requests
from .log import log_json

class AppSyncError(Exception): ...

# Full Job selectionSet (spec §3.1: backend writes return the full row so any consumer of the
# mutation response never sees an omitted-as-null field). The analytics* fields are a LOAD-BEARING
# cross-domain contract: they must exist in the app schema while this scraper is deployed, or every
# createJob/updateJob response errors "field undefined". The app schema (PR 2-A) must never drop them
# while this scraper is live. The scraper never WRITES them — they only round-trip in the response.
_JOB_FIELDS = (
    "id status steamUrl appId gameName headerImage price totalReviews pctPositive "
    "scrapedReviews s3Key errorMessage createdAt updatedAt expiresAt "
    "analyticsStatus analyticsErrorMessage analyticsJson"
)
_CREATE = f"""
mutation Create($input: CreateJobInput!) {{ createJob(input: $input) {{ {_JOB_FIELDS} }} }}
"""
_UPDATE = f"""
mutation Update($input: UpdateJobInput!, $cond: ModelJobConditionInput) {{
  updateJob(input: $input, condition: $cond) {{ {_JOB_FIELDS} }}
}}
"""

class AppSyncClient:
    def __init__(self, url: str, api_key: str, timeout: int = 10):
        self.url, self.api_key, self.timeout = url, api_key, timeout

    def create_job(self, *, job_id, steam_url, app_id, game_name, header_image, price, expires_at) -> None:
        self._post(_CREATE, {"input": {
            "id": job_id, "status": "PENDING", "steamUrl": steam_url, "appId": app_id,
            "gameName": game_name, "headerImage": header_image, "price": price, "expiresAt": expires_at,
        }})

    def transition_running(self, job_id: str) -> bool:
        return self._update({"id": job_id, "status": "RUNNING"}, {"status": {"eq": "PENDING"}})

    def transition_succeeded(self, job_id, *, total_reviews, pct_positive, scraped_reviews, s3_key) -> bool:
        return self._update({"id": job_id, "status": "SUCCEEDED", "totalReviews": total_reviews,
                             "pctPositive": pct_positive, "scrapedReviews": scraped_reviews, "s3Key": s3_key},
                            {"status": {"eq": "RUNNING"}})

    def transition_failed(self, job_id: str, message: str, *, from_status: str = "RUNNING") -> bool:
        return self._update({"id": job_id, "status": "FAILED", "errorMessage": message},
                            {"status": {"eq": from_status}})

    def _update(self, input_: dict, cond: dict) -> bool:
        _data, errors = self._post(_UPDATE, {"input": input_, "cond": cond}, tolerate_errors=True)
        if errors:
            if any("ConditionalCheckFailed" in (e.get("errorType", "") + e.get("message", "")) for e in errors):
                log_json("appsync_condition_noop", job_id=input_.get("id"))
                return False
            raise AppSyncError(str(errors))
        return True

    def _post(self, query: str, variables: dict, tolerate_errors: bool = False) -> Any:
        last: Exception | None = None
        for attempt in range(2):                      # spec §4.2: 1 retry on 5xx/network, 500ms backoff
            try:
                r = requests.post(self.url, json={"query": query, "variables": variables},
                                  headers={"x-api-key": self.api_key, "content-type": "application/json"},
                                  timeout=self.timeout)
                if r.status_code >= 500:
                    raise AppSyncError(f"HTTP {r.status_code}")
                body = r.json()
                errors = body.get("errors")
                if tolerate_errors:
                    return body.get("data"), errors
                if errors:
                    raise AppSyncError(str(errors))
                return body.get("data")
            except (requests.RequestException, AppSyncError) as e:
                last = e
                if attempt == 0:                       # don't sleep after the final attempt
                    time.sleep(0.5)
        raise AppSyncError(f"AppSync call failed after retries: {last}")
