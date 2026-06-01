"""Run after Plan 1 (app) is deployed. Reads AppSync url+key from SSM, then proves the
write-contract the AppSyncClient depends on. Exits non-zero on any mismatch."""
import uuid
import boto3
from reviewlensai_scraper.appsync import AppSyncClient

ssm = boto3.client("ssm")


def p(name):
    return ssm.get_parameter(Name=name)["Parameter"]["Value"]


url, key = p("/reviewlensai/appsync/url"), p("/reviewlensai/appsync/apiKey")
client = AppSyncClient(url, key)
job_id = f"verify-{uuid.uuid4()}"

# 1. createJob with the enum as a string must succeed.
client.create_job(
    job_id=job_id, steam_url="https://store.steampowered.com/app/1/", app_id="1",
    game_name="Verify", header_image=None, price=None, expires_at=0,
)
# 2. The guarded PENDING->RUNNING must commit.
assert client.transition_running(job_id) is True, "RUNNING transition rejected"
# 3. A second PENDING-guarded transition must be a clean NO-OP (False), not raise.
ok = client.transition_failed(job_id, "x", from_status="PENDING")
assert ok is False, "expected ConditionalCheckFailed no-op; matcher mis-pinned or errorType differs"
print("AppSync contract verified for", job_id)
