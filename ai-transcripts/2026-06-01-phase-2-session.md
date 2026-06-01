# Session Transcript — Phase 2 (Analytics)

**Date:** 2026-06-01
**Full transcript (raw Claude Code session JSONL, secrets scrubbed — AWS account id → `<accountId>`, any `da2-` AppSync key → `<appsyncApiKey>`):**
- `2026-06-01-phase-2-session.jsonl` — **Part 1** (brainstorm → spec → plans → precursors → worker 3a), up to the pre-compaction pause.
- `2026-06-01-phase-2-session-part2.jsonl` — **Part 2** (post-compaction): infra 3b, frontend 3c, the worker selectionSet bug fix, docs reconciliation, and the SPA deep-link rewrite.

## Outcome

**Phase 2 (Analytics) is complete: 3b + 3c implemented, deployed, and validated end-to-end on staging.** A real scrape now produces `analyticsStatus: SUCCEEDED` + `analyticsJson`, and the live dashboard renders in the browser (sentiment chart, word association, helpful reviews). The post-deploy E2E caught and fixed a real integration bug (worker mutation selectionSet) and a pre-existing SPA deep-link gap. (Part 1 below was written at the 3a pause; **Part 2** records everything after.)

## Session arc

1. **Context + brainstorming (with visual companion)** — reviewed CLAUDE.md + all domain docs. Converged Phase 2 = **analytics only** (chat deferred to Phase 3). Re-fit the aspirational analytics architecture (Submitter + AWS Batch/Fargate/ECR) to the as-built Phase-1 reality: **a single EventBridge-triggered Python Lambda, NLTK in a plain ZIP (no Docker/ECR)**. User chose to upgrade Amplify (`1.4.0`→latest) since custom-type arrays are still broken even on latest, so the payload stays a JSON-string blob.
2. **Extra analytics** — user picked, then (after the simplicity DA) trimmed to: **review-volume overlay + praise/complaint keyword split**; momentum & context-cuts cut. The `fetch_review_summary` micro-opt fold was dropped (comment-only) — the panel unanimously flagged it as risk to a shipped contract field for sub-second gain.
3. **Spec + Devil's-Advocate panel** — `docs/specs/2026-06-01-phase-2-analytics-design.md`. DA round 1 (correctness / blast-radius / simplicity) + a confirmation pass found & resolved blockers: idempotency guard needed `attributeExists` (not `{eq:null}`); "all-time" mislabeled under the 10k scrape cap → `analyzed*` + `coversFullHistory`; min-English gate (≥20); ISO week-year + UTC bucketing; NLTK `punkt_tab`/`_eng`/`stopwords` data-package names; PMI freq-filter. Blast-radius blockers were **verified against real Phase-1 code** (scraper's hand-coded `_JOB_FIELDS` + `ModelJobConditionInput`).
4. **Dashboard layout** — chose **layout B (dashboard grid)** via the visual companion: sentiment chart full-width on top; keywords beside helpful reviews below.
5. **Plans + DA panels (one per PR, each DA-reviewed & patched)** — five plans:
   - `2026-06-01-phase-2-app-precursor.md` (2-A) · `...-scraper-precursor.md` (2-B) · `...-analytics-worker.md` (3a) · `...-analytics-infra.md` (3b) · `...-analytics-frontend.md` (3c).
   - Plan-DA caught errors that had been baked into the **spec** and corrected them: the round-1 "API-key SSM drift" fix was a **false positive** (`app/amplify/backend.ts` already creates those SSM params via CloudFormation) — removed; `analyticsStatus` switched `a.enum()`→`a.string()` (enum condition inputs lack `attributeExists`); the worker's minimal response selectionSet was explicitly **exempted** from the full-row rule (spec §3 amended). Infra/FE DA caught: `s3:GetObject*` (not `s3:GetObject`) in the IAM assertion, a no-op socket "smoke test" (NLTK reads from disk), the existing `base: Job` literal breaking compile, and a shallow `parseAnalytics` that would crash components.
6. **Execution (subagent-driven: implementer + spec-compliance + code-quality review per unit, with a deploy gate before each merge):**
   - **2-A app precursor — SHIPPED.** Amplify `1.23.0`/`6.17.0`/`1.8.3` + 3 `Job` analytics fields (`analyticsStatus` as `a.string()`). Sandbox validation proved structurally infeasible (backend.ts hardcodes singleton SSM param names → collision), so validation moved post-merge. Staging: table not replaced; `analyticsStatus`→`ModelStringInput` (attributeExists) confirmed on the live API; live scrape `PENDING→RUNNING→SUCCEEDED`. (A self-inflicted detour: misread the SSM `appsync/url` as a "dangling" param — actually the AppSync **api id ≠ the URL subdomain**; the param was correct.)
   - **2-B scraper precursor — SHIPPED.** Published `/reviewlensai/scraper/bucketName`, extended `_JOB_FIELDS` to 18 fields (+ a load-bearing standing-dependency comment), reworded the `fetch_review_summary` comment. Staging: param present; live scrape SUCCEEDED.
   - **3a analytics worker — MERGED to `main` (deploy-inert).** 9 commits, the `reviewlensai_analytics` package (sentiment/words/helpful/payload/s3io/appsync/main) + the shared canonical `analytics_payload.example.json` fixture. Code-quality review caught and we fixed: distinct `no_s3key` skip, **raise on terminal-write guard-miss** (was leaving a job stuck `RUNNING` with no DLQ), `coversFullHistory` None-guard, explicit tiebreak test. **27 tests pass, ruff clean.**

## Architecture decisions (vs the aspirational analytics design)

- **Submitter Lambda + AWS Batch/Fargate + ECR → one EventBridge-triggered Python Lambda** (plain ZIP, NLTK bundled, `reservedConcurrency 3`, `retryAttempts 0` → SQS DLQ + alarms).
- **NLTK (VADER + perceptron POS + PMI collocations)** instead of spaCy (fits a ZIP; no Docker). `nltk==3.9.1` pinned end-to-end; data: `vader_lexicon`, `averaged_perceptron_tagger_eng`, `punkt_tab`, `stopwords`.
- Idempotency via an **atomic `attributeExists:false` conditional `updateJob`** (so `analyticsStatus` must be `a.string()`, not `a.enum()`).
- EventBridge rule / S3 read bound **by name** (no CFN cross-stack import) so scraper deploys are never blocked.
- Payload remains a **JSON-string blob** on `Job.analyticsJson` (Amplify custom-type arrays still broken); a **shared canonical fixture** enforces the worker↔FE contract.

## State at pause / what's next

- **On `main`:** spec + 5 plans committed; precursors 2-A/2-B deployed; worker package 3a + canonical fixture merged.
- **Remaining (resume after compaction):** execute **3b** (analytics CDK stack + `analytics-deploy.yml` — the staging deploy; gated on go-ahead before merge) then **3c** (FE dashboard via app-deploy). Both plans have hard preconditions checking that 3a is on `main` (satisfied). After 3b+3c: E2E (a real scrape yields `analyticsStatus: SUCCEEDED` + `analyticsJson`; dashboard renders), docs reconciliation (`analytics/docs/*`, `OVERVIEW.md`), and a final whole-effort review.

## Memories saved this session

`reference_onedrive_npm_bin` (OneDrive blocks `node_modules/.bin` shims → invoke tools via `node node_modules/...`); `reference_appsync_apiid_vs_url` (AppSync api id ≠ GraphQL URL subdomain — don't parse the id from the URL). **Part 2** also rewrote `feedback_appsync_subscription_merge` (see below).

---

# Part 2 (post-compaction): 3b infra, 3c frontend, bug fix, docs, SPA rewrite

## What shipped

- **3b — analytics infra (PR #5, deployed).** CDK stack: one EventBridge(`ScrapeSucceeded`)-triggered Python 3.12 Lambda, S3 read scoped to `jobs/*` (§6.1 precheck: no bucket policy → identity grant suffices), async `retryAttempts:0` → SQS DLQ, **+ bounded EventBridge target delivery retries (2) to the same DLQ** (DA fix — naive `retryAttempts:0` would silently drop throttled deliveries under `reservedConcurrency:3`), 2 CloudWatch alarms; `analytics-deploy.yml` (NLTK-bundled asset + no-network smoke test). 6/6 CDK tests; `__pycache__` stripped from the asset (DA fix). Deploy green; E2E: real scrape → `analyticsStatus: SUCCEEDED` + `analyticsJson`, live payload shape **byte-for-byte matches the canonical fixture**.
- **3c — analytics dashboard (PR #6, deployed).** `AnalyticsPayload` + tolerant `parseAnalytics` (validates all 6 `words` arrays — DA fix), analytics state threaded through `Job`/`JobView`/`normalize` (with regression tests — whole-PR DA fix), FE-side monthly aggregation (incl. year-boundary test — DA fix), layout-B grid (Recharts sentiment chart w/ weekly·monthly toggle, praise·complaint·overall word association, helpful pos/neg cards), FakeJobClient analytics lifecycle. Chip-key tie-break + `role=group` (not `tablist`) ARIA — DA fixes. 48 tests, tsc + eslint + prod build green.

## The integration bug the E2E caught (PR #7)

After 3b+3c deployed, the backend wrote analytics correctly but **the dashboard never rendered live** — Amplify's `observeQuery` threw `TypeError: Cannot read properties of null (reading 'id')` on each analytics update. Root cause: the worker's `updateJob` returned a **minimal** selectionSet (`id status s3Key analyticsStatus`); AppSync managed subscriptions deliver only the *triggering mutation's* selection set (they do NOT re-read the full item), so the FE got a partial row (foreign fields null) that crashed Amplify's merge. The planning-time "worker is exempt from the full-row rule" decision was **wrong**. Fix: worker `updateJob` returns the full `Job` row (`_FULL_JOB_FIELDS`, mirroring the scraper) + regression test; spec §3 corrected; memory `feedback_appsync_subscription_merge` rewritten (the canonical fix is "every writer returns the full row," not a FE merge shim — the shim it referenced no longer exists). Redeployed → **E2E PASS**: live dashboard rendered (sentiment over 10 weeks, "most recent 10,000 reviews" caption, real adjectives/phrases, helpful reviews with vote/funny/playtime/language chips); Monthly toggle verified live. Screenshot: `screenshots/phase2-analytics-dashboard-e2e.png`.

## Other fixes & closeout

- **Lockfile reconciliation (a83cfda).** The `npm install recharts` (run under the flaky OneDrive `node_modules`) pruned ~428 lines of `@aws-amplify/backend` transitive entries from `app/package-lock.json`, breaking `npm ci` in app-deploy. Fixed via `npm install --package-lock-only`.
- **Docs reconciliation.** `analytics/docs/{CONTEXT,ARCHITECTURE}.md` + OVERVIEW's analytics section rewritten from the aspirational Batch/Submitter/ECR/spaCy design to the as-built single-Lambda/NLTK reality; spec §3 selectionSet exemption corrected.
- **SPA deep-link rewrite (PR #8, deployed).** Hard GETs to `/job/:id` (refresh/bookmark) 404'd — the Amplify app had `customRules: []`. Added the canonical SPA catch-all (non-asset → `/index.html`, 200) as a **checked-in `app/amplify-custom-rules.json` applied by an `app-deploy.yml` step** (`aws amplify update-app --custom-rules file://…`) — declarative & version-controlled, not a one-off CLI mutation. Verified: rule present on the app; a hard deep-link load now returns 200 and renders the full dashboard (also proving the `observeQuery` initial-query path selects the analytics fields).

## Process notes

- Executed subagent-driven: per half (logic / UI) an implementer + spec-compliance review + Devil's-Advocate code-quality review, plus a **whole-PR DA review** on 3c (which surfaced the partial-event risk and the normalize coverage gap). Deploys gated on the user's explicit go-ahead ("implementation, deployment, and testing of 3b and 3c").
- Validation followed the observe-backend-alongside-browser practice: DynamoDB `analyticsStatus` polled in parallel with the live browser to separate FE-render from backend timing.

## State at completion

- **On `main`** (`a221433`): 3b + 3c + worker fix + SPA rewrite merged & deployed; analytics + app domains live on staging; docs/spec/memory reconciled.
- **No production deploy** (PoC = staging only).
