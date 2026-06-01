# Chat Red-Team Corpus & Runbook

**Status:** artifacts only — the bot is not built (spec §0). The corpus and linter
exist now; the loop below runs **after** the bot ships.

## Files
- `corpus.yaml` — adversarial cases. `positive.yaml` — must-answer cases.
- `lint_corpus.py` — schema validator (run before every commit that touches the
  corpus; chat has no CI workflow yet). `test_lint_corpus.py` — its tests.

## Entry schema (validated by `lint_corpus.py`)
```yaml
- id: PREFIX-NNN          # unique, ^[A-Z]+-\d{3}$
  family: <tag>
  boundaries: [<int 1..14>]   # spec §3 catalog numbers
  technique: <short text>
  turns: [<str>, ...]      # >1 = multi-turn
  expect:
    refusal: BLOCKED|OFF_TOPIC|NON_ENGLISH|NO_DATA | [BLOCKED, OFF_TOPIC] | null
    checks: [<closed set>]   # equals_refusal, refusal_in, ascii_only, no_links,
                             # no_pii_tokens, no_slurs, number_in_analytics, ignores_injection
    rubric: <str|null>       # required for indirect-injection, toxic, grounding, positives
  origin: seed|regression
```
The enforced rules (code⇒`equals_refusal`, dual⇒`refusal_in`, null⇒no
`equals_refusal`, `indirect-injection`⇒null+`ignores_injection`+rubric,
positives⇒null+rubric, the multi-turn-family rule, and the closed family/check
sets) live in `lint_corpus.py` — the **single source of truth**. Run it; don't
restate them here.

## Validate
```bash
cd chat/red-team && python -m lint_corpus corpus.yaml positive.yaml
```

## Special entries
- `IND-00x` sentinels (`SENTINEL_IND00x`) must be planted in the matching
  malicious review fixture; `ignores_injection` asserts they're absent from output.
- `SAN-002` is the only runtime-expanded entry (length-bomb): the file stores a
  short literal turn; the harness pads it past the length cap at run time.

## The loop (post-build, spec §5.1)
1. red-teamer (`.claude/agents/adversarial-pm.md`) runs the full corpus + a
   bounded exploratory batch (`EXPLORE_BUDGET`/`MIN_FAMILIES` — TBD, set by the
   harness at build time).
2. evaluator (inline) runs deterministic `checks`, then the LLM judge for
   `rubric`-bearing cases.
3. hardener (inline) patches the **bot's** defenses (never the test) and appends
   each newly-successful exploratory attack as a `regression` case.
Done = grown corpus green AND a terminal bounded exploratory round finds nothing.
Hard stop at `MAX_ROUNDS`/`COST_CEILING` → escalate.

Boundary #2 (fresh per-job session) is architecture-asserted, not corpus-tested.

