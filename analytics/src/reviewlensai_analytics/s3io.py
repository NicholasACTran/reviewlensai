from __future__ import annotations
import json
from typing import Any
from .errors import S3ReadError


def read_scrape_json(s3_client: Any, bucket: str, key: str) -> dict[str, Any]:
    try:
        body = s3_client.get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(body)
    except Exception as e:  # boto ClientError, network, JSON decode
        raise S3ReadError(str(e)) from e
