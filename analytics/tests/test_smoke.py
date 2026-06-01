from reviewlensai_analytics.log import log_json

def test_log_json_is_importable(capsys):
    log_json("worker_start", job_id="abc")
    out = capsys.readouterr().out
    assert '"event": "worker_start"' in out and '"jobId": "abc"' in out
