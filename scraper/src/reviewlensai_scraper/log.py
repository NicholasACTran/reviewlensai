import json
import sys
from typing import Any

def _camel(s: str) -> str:
    head, *tail = s.split("_")
    return head + "".join(w.capitalize() for w in tail)

def log_json(event: str, **fields: Any) -> None:
    """Emit one structured JSON line (spec §4.3: jobId per line)."""
    rec = {"event": event}
    rec.update({_camel(k): v for k, v in fields.items()})
    sys.stdout.write(json.dumps(rec, default=str) + "\n")
