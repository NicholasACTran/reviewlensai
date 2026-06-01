import json
from reviewlensai_scraper.log import log_json

def test_log_json_emits_one_line(capsys):
    log_json("worker_start", job_id="j1", s3_keys=2)
    out = capsys.readouterr().out.strip()
    rec = json.loads(out)
    assert rec["event"] == "worker_start"
    assert rec["jobId"] == "j1"
    assert rec["s3Keys"] == 2
