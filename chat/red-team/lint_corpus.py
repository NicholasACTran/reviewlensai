"""Validate red-team corpus YAML against the Phase 3 spec (§4.1/§4.2).
Usage: python -m lint_corpus corpus.yaml positive.yaml
"""
import re
import sys
import yaml

N_BOUNDARIES = 14
REFUSAL_CODES = {"OFF_TOPIC", "NON_ENGLISH", "NO_DATA", "BLOCKED"}
DUAL = ["BLOCKED", "OFF_TOPIC"]
CHECKS = {
    "equals_refusal", "refusal_in", "ascii_only", "no_links",
    "no_pii_tokens", "no_slurs", "number_in_analytics", "ignores_injection",
}
ID_RE = re.compile(r"^[A-Z]+-\d{3}$")
MULTITURN_FAMILIES = {"direct-injection", "pii", "extraction"}
RUBRIC_REQUIRED_FAMILIES = {"indirect-injection", "toxic", "grounding"}
FAMILIES = {
    "direct-injection", "indirect-injection", "extraction", "tool-probe",
    "isolation", "scope-drift", "non-english-prompt", "non-english-data",
    "pii", "grounding", "toxic", "link-exfil", "sanitization-dos",
    "meta-probe", "positive",
}

class ValidationError(Exception):
    pass

def _err(entry_id, msg):
    raise ValidationError(f"[{entry_id}] {msg}")

def _validate_entry(e, is_positive):
    eid = e.get("id", "<no-id>")
    for key in ("id", "family", "boundaries", "technique", "turns", "expect", "origin"):
        if key not in e:
            _err(eid, f"missing key: {key}")
    if not ID_RE.match(e["id"]):
        _err(eid, "id format must be PREFIX-NNN")
    if e["origin"] not in ("seed", "regression"):
        _err(eid, "origin must be seed|regression")
    if e["family"] not in FAMILIES:
        _err(eid, f"unknown family: {e['family']}")
    bs = e["boundaries"]
    if not isinstance(bs, list) or not bs:
        _err(eid, "boundaries must be a non-empty list")
    for b in bs:
        if not isinstance(b, int) or not (1 <= b <= N_BOUNDARIES):
            _err(eid, f"boundary {b!r} out of range 1..{N_BOUNDARIES}")
    turns = e["turns"]
    if not isinstance(turns, list) or not turns or not all(
        isinstance(t, str) and t.strip() for t in turns
    ):
        _err(eid, "turns must be a non-empty list of non-empty strings")
    exp = e["expect"]
    for key in ("refusal", "checks", "rubric"):
        if key not in exp:
            _err(eid, f"expect missing key: {key}")
    checks = exp["checks"]
    if not isinstance(checks, list):
        _err(eid, "checks must be a list")
    for c in checks:
        if c not in CHECKS:
            _err(eid, f"unknown check: {c}")
    refusal = exp["refusal"]
    if refusal is None:
        if "equals_refusal" in checks:
            _err(eid, "null refusal must not use equals_refusal")
    elif refusal == DUAL:
        if "refusal_in" not in checks:
            _err(eid, "dual-code refusal requires refusal_in check")
    elif isinstance(refusal, str) and refusal in REFUSAL_CODES:
        if "equals_refusal" not in checks:
            _err(eid, "code refusal requires equals_refusal check")
    else:
        _err(eid, f"refusal must be a code, {DUAL}, or null; got {refusal!r}")
    if e["family"] == "indirect-injection":
        if refusal is not None:
            _err(eid, "indirect-injection must have null refusal")
        if "ignores_injection" not in checks:
            _err(eid, "indirect-injection requires ignores_injection check")
    if e["family"] in RUBRIC_REQUIRED_FAMILIES and not exp["rubric"]:
        _err(eid, f"family {e['family']} requires a rubric")
    if is_positive:
        if refusal is not None:
            _err(eid, "positive case must have null refusal")
        if not exp["rubric"]:
            _err(eid, "positive case requires a rubric")

def validate_corpus(doc, is_positive=False, enforce_multiturn=False):
    if not isinstance(doc, list) or not doc:
        raise ValidationError("corpus must be a non-empty list")
    seen = set()
    families_with_multiturn = set()
    for e in doc:
        if not isinstance(e, dict):
            raise ValidationError("each entry must be a mapping")
        if e.get("id") in seen:
            raise ValidationError(f"duplicate id: {e.get('id')}")
        seen.add(e.get("id"))
        _validate_entry(e, is_positive)
        if len(e["turns"]) > 1:
            families_with_multiturn.add(e["family"])
    if enforce_multiturn:
        missing = MULTITURN_FAMILIES - families_with_multiturn
        if missing:
            raise ValidationError(f"families missing multi-turn case: {sorted(missing)}")

def validate_file(path, is_positive=False, enforce_multiturn=False):
    with open(path, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    validate_corpus(doc, is_positive=is_positive, enforce_multiturn=enforce_multiturn)
    return len(doc)

def main(argv):
    ok = True
    for path in argv:
        is_pos = path.endswith("positive.yaml")
        enforce = path.endswith("corpus.yaml")
        try:
            n = validate_file(path, is_positive=is_pos, enforce_multiturn=enforce)
            print(f"OK  {path}: {n} entries")
        except ValidationError as exc:
            ok = False
            print(f"FAIL {path}: {exc}")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
