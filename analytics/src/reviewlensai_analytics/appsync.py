from __future__ import annotations
import time
from typing import Any
import requests
from .log import log_json


class AppSyncError(Exception):
    ...


_JOB_FIELDS = "id status s3Key analyticsStatus"
_GET = f"query Get($id: ID!) {{ getJob(id: $id) {{ {_JOB_FIELDS} analyticsJson }} }}"
_UPDATE = (
    "mutation Update($input: UpdateJobInput!, $cond: ModelJobConditionInput) "
    f"{{ updateJob(input: $input, condition: $cond) {{ {_JOB_FIELDS} }} }}"
)


class AppSyncClient:
    def __init__(self, url: str, api_key: str, timeout: int = 10):
        self.url, self.api_key, self.timeout = url, api_key, timeout

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self._post(_GET, {"id": job_id}).get("getJob")

    def update_analytics(
        self,
        job_id: str,
        *,
        status: str,
        guard_not_started: bool = False,
        analytics_json: str | None = None,
        error_message: str | None = None,
    ) -> bool:
        inp: dict[str, Any] = {"id": job_id, "analyticsStatus": status}
        if analytics_json is not None:
            inp["analyticsJson"] = analytics_json
        if error_message is not None:
            inp["analyticsErrorMessage"] = error_message
        # Guard: null->RUNNING uses attribute_not_exists; later transitions guard on prior status.
        cond = (
            {"analyticsStatus": {"attributeExists": False}}
            if guard_not_started
            else {"analyticsStatus": {"eq": "RUNNING"}}
        )
        data, errors = self._post(_UPDATE, {"input": inp, "cond": cond}, tolerate_errors=True)
        if errors:
            if any(
                "ConditionalCheckFailed" in (e.get("errorType", "") + e.get("message", ""))
                for e in errors
            ):
                log_json("appsync_condition_noop", job_id=job_id, analytics_status=status)
                return False
            raise AppSyncError(str(errors))
        return True

    def _post(self, query: str, variables: dict, tolerate_errors: bool = False) -> Any:
        last: Exception | None = None
        for attempt in range(2):  # 1 retry on 5xx/network, 500ms backoff (spec §8)
            try:
                r = requests.post(
                    self.url,
                    json={"query": query, "variables": variables},
                    headers={"x-api-key": self.api_key, "content-type": "application/json"},
                    timeout=self.timeout,
                )
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
                if attempt == 0:
                    time.sleep(0.5)
        raise AppSyncError(f"AppSync call failed after retries: {last}")
