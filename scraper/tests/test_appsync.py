import responses
from reviewlensai_scraper.appsync import AppSyncClient

URL = "https://example.appsync-api.us-east-1.amazonaws.com/graphql"

def make(): return AppSyncClient(URL, "da2-key")

@responses.activate
def test_create_job_sends_api_key_and_pending():
    responses.post(URL, json={"data": {"createJob": {"id": "j1"}}})
    make().create_job(job_id="j1", steam_url="u", app_id="1", game_name="G", header_image=None, price="$5", expires_at=123)
    req = responses.calls[0].request
    assert req.headers["x-api-key"] == "da2-key"
    assert "createJob" in req.body.decode()
    assert '"status":"PENDING"' in req.body.decode().replace(" ", "")

@responses.activate
def test_transition_running_sends_condition():
    responses.post(URL, json={"data": {"updateJob": {"id": "j1", "status": "RUNNING"}}})
    make().transition_running("j1")
    body = responses.calls[0].request.body.decode().replace(" ", "")
    assert '"status":"RUNNING"' in body
    # condition guards on prior state PENDING (spec §3.1)
    assert "PENDING" in responses.calls[0].request.body.decode()

@responses.activate
def test_conditional_check_failed_is_noop_not_raise():
    responses.post(URL, json={"data": {"updateJob": None},
                              "errors": [{"errorType": "ConditionalCheckFailedException"}]})
    # guard miss must be a no-op (returns False), not an exception
    assert make().transition_running("j1") is False

@responses.activate
def test_retries_on_5xx_then_succeeds():
    responses.post(URL, status=502)
    responses.post(URL, json={"data": {"updateJob": {"id": "j1"}}})
    assert make().transition_failed("j1", "Scrape failed. Try again.") is True
    assert len(responses.calls) == 2
