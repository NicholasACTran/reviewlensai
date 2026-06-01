import json
import pytest
from reviewlensai_analytics.s3io import read_scrape_json
from reviewlensai_analytics.errors import S3ReadError


class _Body:
    def __init__(self, b):
        self._b = b

    def read(self):
        return self._b


class _S3Ok:
    def get_object(self, Bucket, Key):
        return {"Body": _Body(json.dumps({"reviews": []}).encode())}


class _S3Err:
    def get_object(self, Bucket, Key):
        raise RuntimeError("boom")


def test_reads_and_parses():
    assert read_scrape_json(_S3Ok(), "b", "jobs/x/1.json") == {"reviews": []}


def test_wraps_failure_as_s3readerror():
    with pytest.raises(S3ReadError):
        read_scrape_json(_S3Err(), "b", "k")


def test_bad_json_is_s3readerror():
    class _Bad:
        def get_object(self, **k):
            return {"Body": _Body(b"not json")}

    with pytest.raises(S3ReadError):
        read_scrape_json(_Bad(), "b", "k")
