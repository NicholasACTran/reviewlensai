# Phase 2 Scraper-Precursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scraper domain ready for the analytics domain: publish the scrape-bucket name to SSM (analytics needs it for the S3 read grant), align the scraper's `Job` response selectionSet to the now-19-field schema, and correct a misleading comment — without changing scrape behavior.

**Architecture:** Three small, low-risk changes in the **scraper domain only**: (1) a new SSM `StringParameter` for the bucket name in the CDK stack; (2) add the three analytics field names to the hand-coded `_JOB_FIELDS` response selectionSet; (3) reword a code comment. Validated post-merge by a scraper deploy + a live scrape (the selectionSet now references the analytics fields, which exist in the schema only because PR 2-A deployed first).

**Tech Stack:** Python 3.12 (scraper Lambdas), AWS CDK (TypeScript), AWS SSM, GitHub Actions, pytest, ruff, **jest** (CDK tests — `scraper/cdk/package.json` `"test": "jest"`, ts-jest preset; there is NO vitest here).

**Spec:** `docs/specs/2026-06-01-phase-2-analytics-design.md` §2-B, §6.1.

**Prerequisite:** PR 2-A (app precursor) is **merged and deployed** — the schema now has `analyticsStatus`/`analyticsErrorMessage`/`analyticsJson`, so the scraper may safely request them in its response selectionSet. (Confirmed live: api `xfj4tgpqsvgfbaxoyybuekelui` has `analyticsStatus`.)

**Environment facts:** AWS CLI default profile, acct `934939427723`, `us-east-1`. `jq` is **unavailable** in the local shell — use `aws --query/--output text` or `node`. On Windows, OneDrive blocks `node_modules/.bin` shims — run npm-tool binaries via `node node_modules/...` (CI on Linux is fine). `MSYS_NO_PATHCONV=1` for `aws ssm` calls whose `--name` starts with `/`. Scraper deploys via `.github/workflows/scraper-deploy.yml` on push to `main` (paths `scraper/**`); the scraper reads app SSM params at synth (app must be deployed first — it is).

---

## File Structure

- **Modify** `scraper/cdk/lib/scraper-stack.ts` — add a `BucketNameParam` SSM `StringParameter`.
- **Modify** `scraper/cdk/test/scraper-stack.test.ts` — assert the new param.
- **Modify** `scraper/src/reviewlensai_scraper/appsync.py` — extend `_JOB_FIELDS`.
- **Modify** `scraper/src/reviewlensai_scraper/steam.py` — reword the `fetch_review_summary` comment.
- **Modify** `scraper/docs/API_CONTRACT.md` — document the new `bucketName` param in §5.

---

## Task 1: Branch and confirm a green baseline

**Files:** none (setup + verification).

- [ ] **Step 1: Clean tree, branch, baseline (Python + CDK tests)**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git switch main && git pull --ff-only \
  && git switch -c phase2/scraper-precursor \
  && (cd scraper && .venv/Scripts/python.exe -m pytest -q && .venv/Scripts/ruff.exe check src tests scripts) \
  && (cd scraper/cdk && npm ci && node node_modules/jest/bin/jest.js)
```
Expected: on `phase2/scraper-precursor`; scraper pytest + ruff clean; CDK (jest) tests PASS. **Tooling notes:** use the scraper's venv binaries (`scraper/.venv/Scripts/python.exe`, `.../ruff.exe`) — the ambient `python` may lack the deps, and OneDrive blocks `.bin` shims. Lint `src tests scripts` (NOT `.`) to match CI (`ruff check src tests scripts`) and avoid linting vendored `build/`. If the venv path differs, replicate CI: `pip install -e .[dev]` then `pytest`/`ruff`. If baseline is red, STOP.

---

## Task 2: Publish the bucket name to SSM (TDD on the CDK stack)

**Files:** `scraper/cdk/lib/scraper-stack.ts`, `scraper/cdk/test/scraper-stack.test.ts`

- [ ] **Step 1: Write the failing CDK test**

In `scraper/cdk/test/scraper-stack.test.ts`, add after the existing tests (before EOF):
```ts
test("publishes the scrape bucket name to SSM for the analytics domain", () => {
  synth().hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/reviewlensai/scraper/bucketName",
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/scraper/cdk" && node node_modules/jest/bin/jest.js
```
Expected: the new test FAILS (no SSM param named `/reviewlensai/scraper/bucketName` yet); existing tests pass.

- [ ] **Step 3: Add the SSM parameter to the stack**

In `scraper/cdk/lib/scraper-stack.ts`, in the "Outputs back to the contract" block (after the `ValidatorUrlParam` StringParameter, before the closing `}`), add:
```ts
    // Phase 2: analytics reads raw scrape data from this bucket; it needs the bucket
    // name at synth for the s3:GetObject grant + worker S3_BUCKET env (spec §6.1).
    new ssm.StringParameter(this, "BucketNameParam", {
      parameterName: "/reviewlensai/scraper/bucketName",
      stringValue: bucket.bucketName,
    });
```

- [ ] **Step 4: Run tests to confirm green**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/scraper/cdk" && node node_modules/jest/bin/jest.js
```
Expected: all CDK tests PASS (including the new one).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add scraper/cdk/lib/scraper-stack.ts scraper/cdk/test/scraper-stack.test.ts \
  && git commit -m "feat(scraper): publish scrape bucket name to SSM for analytics"
```

---

## Task 3: Align `_JOB_FIELDS` to the 19-field schema

**Files:** `scraper/src/reviewlensai_scraper/appsync.py`

- [ ] **Step 1: Extend the selectionSet (and document the standing dependency)**

In `scraper/src/reviewlensai_scraper/appsync.py`, update the comment above `_JOB_FIELDS` and append the three analytics field names (existing 15 + 3 = 18 requested fields). Replace the existing `_JOB_FIELDS` block (its leading comment + the constant) with:
```python
# Full Job selectionSet (spec §3.1: backend writes return the full row so any consumer of the
# mutation response never sees an omitted-as-null field). The analytics* fields are a LOAD-BEARING
# cross-domain contract: they must exist in the app schema while this scraper is deployed, or every
# createJob/updateJob response errors "field undefined". The app schema (PR 2-A) must never drop them
# while this scraper is live. The scraper never WRITES them — they only round-trip in the response.
_JOB_FIELDS = (
    "id status steamUrl appId gameName headerImage price totalReviews pctPositive "
    "scrapedReviews s3Key errorMessage createdAt updatedAt expiresAt "
    "analyticsStatus analyticsErrorMessage analyticsJson"
)
```
(These fields exist in the schema since PR 2-A deployed; deploying this before 2-A — or after a 2-A rollback that dropped them — would break **every** scrape, not a subset: `createJob` raises `AppSyncError`, and every `updateJob` transition re-raises the non-`ConditionalCheckFailed` error.)

- [ ] **Step 2: Run the scraper suite to confirm nothing breaks**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/scraper" && .venv/Scripts/python.exe -m pytest -q && .venv/Scripts/ruff.exe check src tests scripts
```
Expected: all PASS. `test_appsync.py` asserts on request bodies / mocked responses, not the literal `_JOB_FIELDS` string (verified), so extending it changes no test.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add scraper/src/reviewlensai_scraper/appsync.py \
  && git commit -m "feat(scraper): include analytics fields in Job response selectionSet"
```

---

## Task 4: Reword the `fetch_review_summary` comment

**Files:** `scraper/src/reviewlensai_scraper/steam.py`

- [ ] **Step 1: Reword the misleading NOTE**

In `scraper/src/reviewlensai_scraper/steam.py`, replace the `fetch_review_summary` docstring NOTE so it does not assert the redundancy as fact:
```python
def fetch_review_summary(app_id: str) -> tuple[int, int]:
    """Returns (total_reviews, total_positive) via a dedicated summary request.
    NOTE (Phase 2, unverified): it was hypothesized that the first `filter=recent` page
    (cursor='*') also returns these totals in its query_summary, which would let us fold
    this call into scrape_reviews' first page and save one Steam request. This was NOT
    verified — Steam may populate query_summary differently under `filter=recent` than
    `filter=all`. Do not remove this dedicated call without confirming both total_reviews
    AND total_positive match `filter=all` across several appIds (incl. 0-review and >10k)."""
```

- [ ] **Step 2: Lint + test (no behavior change)**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/scraper" && .venv/Scripts/ruff.exe check src tests scripts && .venv/Scripts/python.exe -m pytest -q
```
Expected: all PASS (comment-only change).

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add scraper/src/reviewlensai_scraper/steam.py \
  && git commit -m "docs(scraper): mark fetch_review_summary fold hypothesis as unverified"
```

---

## Task 5: Update the API contract doc, open PR, DA review, merge

**Files:** `scraper/docs/API_CONTRACT.md`

- [ ] **Step 1: Document the new SSM param**

In `scraper/docs/API_CONTRACT.md` §5 (SSM parameters table), add a row:
```
| `/reviewlensai/scraper/bucketName`     | Scraper  | Phase 2     | Scrape-output S3 bucket name (analytics S3 read grant + worker `S3_BUCKET`) |
```

- [ ] **Step 2: Commit the doc**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add scraper/docs/API_CONTRACT.md \
  && git commit -m "docs(scraper): document bucketName SSM param in API contract"
```

- [ ] **Step 3: Push, open PR**

```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git push -u origin phase2/scraper-precursor \
  && gh pr create --base main --head phase2/scraper-precursor \
     --title "Phase 2 scraper precursor: bucketName SSM + Job selectionSet + comment" \
     --body "$(cat <<'EOF'
Implements spec §2-B (docs/specs/2026-06-01-phase-2-analytics-design.md).

- feat(scraper): publish /reviewlensai/scraper/bucketName to SSM (analytics S3 read grant needs it)
- feat(scraper): add analyticsStatus/analyticsErrorMessage/analyticsJson to _JOB_FIELDS response selectionSet (18 fields)
- docs(scraper): mark the fetch_review_summary fold hypothesis as unverified (fold dropped per §14.2)
- docs(scraper): document bucketName in API_CONTRACT §5

No scrape-behavior change. The analytics fields exist in the schema (PR 2-A deployed), so the selectionSet is valid. Validated post-merge: bucketName param present in SSM; a live scrape still reaches SUCCEEDED.
EOF
)"
```

- [ ] **Step 4: Pre-merge sanity, DA code review, then merge**

Before merging, confirm the 3 app SSM params the scraper bakes at synth are current
(this deploy re-bakes whatever SSM holds into the Lambda env + Validator CORS origin):
```bash
for P in /reviewlensai/appsync/url /reviewlensai/appsync/apiKey /reviewlensai/amplify/url; do \
  echo -n "$P = "; MSYS_NO_PATHCONV=1 aws ssm get-parameter --name "$P" --query Parameter.Name --output text --region us-east-1; done
```
Expected: all three resolve (present). (We confirmed `appsync/url`/`apiKey` are valid earlier.) Then run a DA code reviewer on the PR diff (CLAUDE.md 6.3); resolve blockers. Then merge:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" && gh pr merge phase2/scraper-precursor --merge
```
Expected: merged → push to `main` triggers `scraper-deploy.yml`. **Note the cascade:** `scraper-deploy.yml`'s final step runs `gh workflow run app-deploy.yml`, so the merge fires **two** pipelines (scraper deploy + an app frontend rebuild). The rebuild re-bakes `VITE_VALIDATOR_URL` (unchanged here) and redeploys the live FE — glance at `git log origin/main -- app/` first to confirm no unrelated unreleased app commits would ship with it.

---

## Task 6: Post-merge staging validation

**Files:** none.

- [ ] **Step 1: Watch the scraper deploy to green**

Run:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && gh run watch $(gh run list --workflow scraper-deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```
(If `--jq` is unavailable, use `gh run list --workflow scraper-deploy.yml --limit 1` and copy the id.) Expected: `scraper-deploy` completes green.

- [ ] **Step 2: Confirm the new SSM param exists**

Run:
```bash
MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /reviewlensai/scraper/bucketName --query Parameter.Value --output text --region us-east-1
```
Expected: prints the scrape bucket name (non-empty). Analytics synth (PR 3) can now read it.

- [ ] **Step 3: Live scrape still works (selectionSet now references analytics fields)**

Run (self-contained; `jq`-free):
```bash
VURL=$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /reviewlensai/scraper/validatorUrl --query Parameter.Value --output text --region us-east-1) \
  && TABLE=$(aws dynamodb list-tables --region us-east-1 --query "TableNames[?starts_with(@,'Job-')]" --output text) \
  && RESP=$(curl -s -X POST "$VURL" -H 'content-type: application/json' -d '{"url":"https://store.steampowered.com/app/367520/Hollow_Knight/"}') \
  && JOB=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).jobId)||'PARSE_FAIL')" "$RESP") \
  && echo "jobId=$JOB" \
  && for i in $(seq 1 50); do \
       ST=$(aws dynamodb get-item --table-name "$TABLE" --region us-east-1 --key "{\"id\":{\"S\":\"$JOB\"}}" --query "Item.status.S" --output text 2>/dev/null); \
       echo "poll $i: $ST"; \
       [ "$ST" = "SUCCEEDED" ] && { echo "PASS"; break; }; \
       [ "$ST" = "FAILED" ] && { echo "FAIL — inspect scraper logs"; break; }; \
       sleep 6; \
     done
```
Expected: reaches `SUCCEEDED`. Proves the extended `_JOB_FIELDS` selectionSet is valid against the live schema (the scraper's `createJob`/`updateJob` responses now request the analytics fields, which exist). **Don't persist secrets/responses to the transcript.**

- [ ] **Step 4: Rollback (ONLY if a step fails)**

If the deploy or scrape breaks, revert the merge and redeploy:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git switch main && git pull --ff-only \
  && git revert --no-edit <merge-commit-sha> && git push origin main
```

---

## Definition of Done (maps to spec §2-B)

- [ ] `/reviewlensai/scraper/bucketName` published to SSM (CDK test + live param).
- [ ] `_JOB_FIELDS` includes the 3 analytics fields (18 total); scraper suite green.
- [ ] `fetch_review_summary` comment reworded (hypothesis marked unverified; no code change).
- [ ] `scraper/docs/API_CONTRACT.md` §5 documents `bucketName`.
- [ ] Post-merge: scraper deploy green; bucketName param present; live scrape SUCCEEDED.
- [ ] Merged in attributable commits; DA code review passed.

---

## Self-Review notes
- **Spec coverage:** §2-B.1 → Task 2 + Task 5 Step 1 (doc); §2-B.2 → Task 3; §2-B.3 → Task 4. §6.1 (analytics needs `bucketName`) is satisfied by Task 2. No gaps.
- **Deploy order:** scraper deploys *after* app (already deployed), so the analytics fields in `_JOB_FIELDS` resolve against a schema that has them. If run before PR 2-A, the selectionSet would error — but 2-A is merged/deployed.
- **No scrape-behavior change:** Tasks 3–4 don't alter pagination/transition logic; the selectionSet only affects which fields the mutation *response* returns.
- **Type consistency:** the 3 field names exactly match the schema (`analyticsStatus`, `analyticsErrorMessage`, `analyticsJson`) and the SSM param name matches what analytics (PR 3, §6.1) will read.
