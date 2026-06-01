import responses
from reviewlensai_analytics.appsync import AppSyncClient

URL = "https://x.example/graphql"


@responses.activate
def test_update_running_guarded_on_attribute_not_exists():
    responses.post(URL, json={"data": {"updateJob": {"id": "j1", "analyticsStatus": "RUNNING"}}})
    ok = AppSyncClient(URL, "k").update_analytics("j1", status="RUNNING", guard_not_started=True)
    assert ok is True
    body = responses.calls[0].request.body
    if isinstance(body, bytes):
        body = body.decode()
    assert "RUNNING" in body and "attributeExists" in body  # guard present


@responses.activate
def test_conditional_miss_is_noop_not_raise():
    responses.post(URL, json={"errors": [{"errorType": "ConditionalCheckFailedException", "message": "x"}]})
    assert AppSyncClient(URL, "k").update_analytics("j1", status="RUNNING", guard_not_started=True) is False


@responses.activate
def test_get_job_returns_row():
    responses.post(
        URL,
        json={
            "data": {
                "getJob": {
                    "id": "j1",
                    "status": "SUCCEEDED",
                    "analyticsStatus": None,
                    "s3Key": "k",
                }
            }
        },
    )
    assert AppSyncClient(URL, "k").get_job("j1")["status"] == "SUCCEEDED"
