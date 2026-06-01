# Phase 2 — Analytics: Design Spec

**Date:** 2026-06-01
**Status:** Draft — patched after DA panel round 1 (see §15)
**Scope:** Analytics domain only. Phase 3 chat is deferred; this design builds
nothing chat-specific and adds no forward-compat hooks for it (per YAGNI).
**PRD:** `docs/prds/phase-2.md`
**Supersedes:** the aspirational `analytics/docs/ARCHITECTURE.md` (Submitter +
Batch/Fargate + ECR + `aws.batch` trigger), which assumed a heavyweight Batch
scraper that Phase 1 never built.

---

## §1. Goals & non-goals

### Goals
- Turn the raw scraped reviews at `jobs/{jobId}/{appId}.json` into surface-level
  analytics, written back onto the shared `Job` row for the FE to render via its
  existing `observeQuery` subscription.
- Deliver the three PRD analytics **plus two extras** (volume overlay,
  praise/complaint keyword split) chosen in brainstorming (§4).
- Fit the architecture to the **as-built Phase 1** (Lambda scraper, custom
  `ScrapeSucceeded` event, `x-api-key` AppSync writes).

### Non-goals
- No LLMs (classical ML only — VADER + NLTK).
- No chat ingestion / Bedrock / knowledge base / forward-compat versioning.
- No analytics watchdog/sweeper (deferred, §9).
- No re-run / re-analyze UX (one idempotent pass per job).

---

## §2. Prerequisites — two single-domain precursor PRs

The DA blast-radius review showed a single bundled precursor PR would (a) fan out
to **both** `app-deploy` and `scraper-deploy` pipelines on one merge, defeating the
app-before-scraper deploy order, and (b) make a staging failure impossible to
attribute. So the precursor is **split into two independently-validated PRs**, both
merged and green on staging **before** the analytics branch forks.

### §2-A. App-domain precursor PR (merge & deploy first)
1. **Amplify upgrade.** Bump `@aws-amplify/backend` + `@aws-amplify/backend-cli`
   `^1.4.0` → latest stable (`~1.21–1.23.x`); `aws-amplify` → latest compatible
   `6.x`. Regenerate + sync lockfile. **In a separate commit from the field-add
   below** so each CFN changeset is independently attributable.
2. **`Job` schema field-add** (§3) — separate commit.
3. **(No SSM-republish step — corrected.)** `app/amplify/backend.ts:14-24` already
   creates `/reviewlensai/appsync/url` and `/reviewlensai/appsync/apiKey` as
   **CloudFormation-managed `StringParameter`s** (sourced from
   `backend.data.graphqlUrl` and `cfnApiKey.attrApiKey`), so CFN keeps them in
   lockstep with the API on every `pipeline-deploy`. The round-1 "API-key SSM
   drift" blocker was a **false positive** (it inspected only `app-deploy.yml`,
   which republishes solely the *hosting* URL, and missed the backend-stack
   params). Adding a workflow `put-parameter --overwrite` would create a harmful
   *second writer* to a CFN-managed param. **Nothing to do here.** (Optional belt:
   a read-only post-deploy assertion that SSM `apiKey` == `amplify_outputs.json`
   `.data.api_key` — never a write.)
4. **Acceptance gate (validate the fragile surfaces; cheap > exhaustive):**
   - **Pre-merge, isolated:** deploy the branch to an Amplify **sandbox**
     (`ampx sandbox --once`) and introspect its SDL to confirm (a)
     `ModelJobConditionInput` still exists by that exact name (the scraper hard-codes
     it), and (b) `analyticsStatus`'s condition entry is `ModelStringInput` — i.e.
     exposes `attributeExists`, which the §7 guard needs. App
     `lint`/`typecheck`/`test` green.
   - **Post-merge, on staging (== `main` deploy):** confirm the `Job` DynamoDB table
     was **not replaced** (`TableId` unchanged across the deploy), then run a real
     scrape that drives `PENDING→RUNNING→SUCCEEDED` — proving the scraper's
     conditional `updateJob`/`ModelJobConditionInput` mutations still work against
     the upgraded schema. **Rollback if broken:** revert the merge commit and
     redeploy from `main` HEAD.
   - *(The previous "GraphQL SDL before/after diff" gate is dropped — the live
     conditional scrape is a strictly stronger proof, and the sandbox check already
     validates the type names the scraper depends on.)*

### §2-B. Scraper-domain precursor PR (merge & deploy second)
1. **Publish `/reviewlensai/scraper/bucketName` to SSM** (new param). Analytics
   synth needs it for the S3 read grant (§6.1); the scraper does **not** currently
   publish it. Update `scraper/docs/API_CONTRACT.md` §5.
2. **Add the 3 analytics fields to the scraper's `_JOB_FIELDS`** response
   selectionSet (`scraper/src/reviewlensai_scraper/appsync.py:11`) so every writer
   returns the full row (15 existing + 3 analytics = **18 fields**), preserving the
   spec-§3.1 "writers return the full row" invariant. (Confirmed
   `scraper/tests/test_appsync.py` asserts on request body / mocked responses, not
   the selectionSet string, so this add breaks no existing scraper test.) (Strictly, `observeQuery` re-reads the full item from DynamoDB
   so a subset *response* selectionSet would not actually corrupt the FE view —
   but aligning the writers removes the ambiguity for one-line cost.)
3. **`fetch_review_summary` — comment-only (fold dropped, user decision §14.2).**
   The dedicated `filter=all&num_per_page=0` call stays. The comment at
   `scraper/src/reviewlensai_scraper/steam.py:45` currently asserts as *fact* that
   the `filter=recent` first page carries the same totals — reword it to mark that
   claim **unverified** (Steam may populate `query_summary` differently under
   `filter=recent`), so a future reader doesn't fold the call on the strength of an
   unchecked assertion. No change to `scrape_reviews`, no risk to the Phase-1
   contract fields `totalReviews`/`pctPositive`. Revisitable in Phase 4.

The analytics feature branch forks off `main` only after §2-A and §2-B are merged
and validated on staging.

---

## §3. Data model — `Job` row additions

Three new fields on the `Job` Amplify model (`app/amplify/data/resource.ts`).
Typed scalars where cheap; a JSON-string blob for the array-heavy payload (custom-
type arrays remain mis-generated on current Amplify, so the blob stands regardless
of version).

```ts
analyticsStatus: a.string(),        // values "RUNNING"|"SUCCEEDED"|"FAILED"; attribute ABSENT = not started
analyticsErrorMessage: a.string(),  // nullable; closed set (§8)
analyticsJson: a.string(),          // nullable; JSON-stringified AnalyticsPayload (§5)
```

- **`analyticsStatus` is `a.string()`, not `a.enum()` (corrected after plan-DA).**
  An `a.enum()` field generates a condition input with only `eq/ne/in/notIn` — **no
  `attributeExists`** — so the §7 `attribute_not_exists` idempotency guard would be
  unbuildable. `a.string()` generates `ModelStringInput`, which exposes
  `attributeExists`. The values are a closed set (`RUNNING|SUCCEEDED|FAILED`)
  enforced by the worker + the FE's hand-rolled `AnalyticsStatus` union type; the
  schema field stays a plain nullable string.
- **No `PENDING`.** The single worker writes `RUNNING` first. The field is
  **absent** (not stored `NULL`) until then — this matters for the guard (§7).
- **Sole writer:** the Analytics Lambda. Validator/Scraper never touch these fields.
- **Auth:** `x-api-key`, exactly like the scraper. No AppSync IAM/SigV4; `apiId`
  SSM param stays dropped.
- **Mutation input vs response selectionSet (normative, corrects round-1 wording).**
  The analytics `updateJob` **input** contains only `id`, the analytics field(s)
  being written, and the guard `condition` — it never echoes scraper-owned fields
  (no read-modify-write of foreign fields, per API_CONTRACT §2.1).
  - **Scraper** writers return the full `Job` row in their mutation **response**
    selectionSet (its `appsync.py` 18-field `_JOB_FIELDS`).
  - **Analytics worker is explicitly exempt** (amended after plan-DA): its
    `updateJob`/`getJob` use a **minimal** response selectionSet
    (`id status s3Key analyticsStatus [analyticsJson]`). This is safe because (a)
    the worker never consumes the mutation response, and (b) the FE's `observeQuery`
    re-reads the full DynamoDB item, so the response selectionSet never reaches the
    FE. Forcing the worker to mirror all 18 field names would add a maintenance
    mirror it doesn't use. No partial-merge bug arises either way.

---

## §4. Analytics deliverables

**English-subset rule.** NLP analytics (sentiment, word association) run on
`review.language == "english"` (Steam's lowercase code; language-agnostic
analytics use all reviews). **Minimum-English gate:** if `englishReviewCount < 20`,
NLP sections are emitted empty and the FE renders "Not enough English-language
reviews to analyze text"; language-agnostic sections still render.

**Scraped-window honesty (corrects "all-time").** The scrape keeps the **newest**
≤10k reviews (`filter=recent`, capped at `MAX_REVIEWS`). For games with
`totalReviews > scrapedReviews`, every aggregate covers only the scraped window,
**not** true history. The payload therefore uses `analyzed*` naming (never
`allTime*`) and carries `coversFullHistory` so the FE can label "based on the most
recent N reviews."

**Bucketing determinism.** Time buckets key on `timestamp_created` via
`datetime.fromtimestamp(ts, tz=timezone.utc)`. Weekly keys use **ISO week-year**
`(iso_year, iso_week)` from `dt.isocalendar()` (not calendar `dt.year`) to avoid
year-boundary collisions.

### PRD deliverables
1. **Sentiment over time** — VADER `compound` per English review, aggregated into
   **weekly ISO buckets** (`avgCompound`, `reviewCount`), plus an
   `analyzedAvgCompound` scalar. The FE derives the monthly view by
   count-weighted aggregation of weekly buckets (worker emits one granularity; §15).
2. **Word association** — top 5 **adjectives** (NLTK perceptron POS → `JJ*`,
   lemmatized, lowercased, stopword- + game-name-filtered) and top 5 **phrases**
   (NLTK bigram/trigram collocations ranked by PMI **after**
   `apply_freq_filter(≥5, scaled to corpus)** so rare one-off pairs don't dominate).
3. **Most helpful reviews** — top 3 positive (`voted_up`) and top 3 negative, each
   requiring `votes_up >= 1`, ranked by `votes_up` desc (tiebreak `votes_funny`
   desc, then newer). Language-agnostic; each carries `language`. Text capped at
   1,000 chars (§15 flag).

### Extras (kept per user decision §14.1; momentum & context-cuts cut)
4. **Review volume over time** — *free*: the `reviewCount` already in each weekly
   bucket; FE overlays volume bars on the sentiment line.
5. **Praise vs complaint keywords** — the §4.2 extraction re-run on the `voted_up`
   and `!voted_up` partitions → `praise*` / `complaint*` lists. Directly upgrades
   the PRD word-association deliverable.

*(Cut: sentiment momentum and the context-cuts bundle — see §14.1/§15. The raw
fields they would have used (`steam_purchase`, `received_for_free`,
`written_during_early_access`, author playtime) are left unused for now.)*

---

## §5. `AnalyticsPayload` contract (single source of truth)

TS interface at `app/src/types/analytics.ts`. The Python worker emits
`json.dumps(payload)` with these exact camelCase keys; the FE parses via tolerant
`parseAnalytics(json): AnalyticsPayload | null` (never throws). Worker, FE
renderer, and FakeAmplifyClient fixtures all conform.

```ts
interface SentimentBucket { period: string; avgCompound: number; reviewCount: number; } // period: "2024-W03" (ISO week-year)
interface Keyword        { term: string; count: number; }
interface HelpfulReview  { text: string; votesUp: number; votesFunny: number; votedUp: boolean;
                           createdAt: number; language: string; playtimeForeverHours: number | null; }

interface AnalyticsPayload {
  hasData: boolean;               // false ⇒ FE renders "not enough reviews"
  coversFullHistory: boolean;     // scrapedReviews >= totalReviews
  totalAnalyzed: number;          // all scraped reviews considered
  englishReviewCount: number;     // subset used for NLP (gate: <20 ⇒ NLP empty)
  sentiment: { weekly: SentimentBucket[]; analyzedAvgCompound: number | null; };
  words: {
    overallAdjectives: Keyword[];   overallPhrases: Keyword[];      // top 5 each
    praiseAdjectives: Keyword[];    praisePhrases: Keyword[];
    complaintAdjectives: Keyword[]; complaintPhrases: Keyword[];
  };
  helpful: { positive: HelpfulReview[]; negative: HelpfulReview[]; }; // ≤3 each
}
```

No `schemaVersion` (dropped — non-goals forbid chat forward-compat; `parseAnalytics`
tolerance already guards shape drift; add versioning the day a second schema exists).
No `momentum` / `contextCuts` blocks (extras cut per §14.1).

---

## §6. Architecture & AWS resources

A single async Python Lambda, EventBridge-triggered. CDK at
`analytics/cdk/lib/analytics-stack.ts`.

- **Analytics Lambda** — Python 3.12, plain **ZIP** asset (no Docker/ECR),
  1024 MB, **600 s**, **reservedConcurrency 3**, async **retryAttempts 0**,
  on-failure → SQS DLQ. **NLTK pinned to an exact version**; the build vendors
  `nltk` + the **exact data packages that version requires** — for NLTK ≥3.8.2
  that is `vader_lexicon`, `averaged_perceptron_tagger_eng`, `punkt_tab`, **and
  `stopwords`** (the un-suffixed `punkt`/`averaged_perceptron_tagger` names trigger a
  `LookupError`; omitting `stopwords` silently degrades word-association filtering to
  a tiny fallback set). `NLTK_DATA` points at the bundled path; **no runtime
  download**. Note `sentiment.py` instantiates VADER at module import, so a
  missing/mis-pathed bundle is an import-time crash — the §11 no-network smoke test
  MUST import the worker modules under the bundled `NLTK_DATA` to catch this.
- **EventBridge rule** on the `reviewlensai` bus, filtered to
  `Source == "reviewlensai.scraper"` AND `DetailType == "ScrapeSucceeded"`, target
  the Lambda (async). Bus **bound by name** read at synth from SSM
  `/reviewlensai/scraper/eventBusName` — **not** a CFN cross-stack import (so
  scraper deploys are never blocked by analytics). Trade-off: a stale/renamed bus
  name yields silent non-triggering (acceptable per §9's no-watchdog stance).
- **SQS DLQ** + two **CloudWatch alarms** (DLQ depth; Lambda `Errors`).
- **CloudWatch log group**, 14-day retention.
- **IAM (execution role):** `s3:GetObject` on `arn:aws:s3:::<scrapeBucket>/jobs/*`;
  Logs; `sqs:SendMessage` to its DLQ. No AppSync IAM grant (`x-api-key` over HTTPS).

### §6.1 SSM cross-domain reads (synth time) + pre-impl checks
| Parameter | Producer | Used for |
|---|---|---|
| `/reviewlensai/scraper/eventBusName` | scraper | rule binding (by name) |
| `/reviewlensai/scraper/bucketName` | scraper (**new, §2-B**) | S3 grant + runtime `S3_BUCKET` |
| `/reviewlensai/appsync/url` | app | `Job` write endpoint |
| `/reviewlensai/appsync/apiKey` | app | `x-api-key` |

- **Pre-impl check:** confirm the scraper bucket has **no restrictive resource
  (bucket) policy** — an identity-based `s3:GetObject` grant suffices only if no
  bucket-policy `Deny` overrides it. If one exists, reading it requires a
  scraper-stack bucket-policy change (a real cross-domain coupling) and must be
  called out as such.
- **Deploy order:** app (§2-A) → scraper (§2-B, publishes `bucketName`) → analytics.

---

## §7. Worker runtime flow

`analytics_worker/main.py`, invoked per `ScrapeSucceeded` event.

1. Parse `detail.jobId`/`detail.s3Key`; missing → `worker_skipped{reason}` exit 0.
2. **Idempotency guard** — `getJob(jobId)`; proceed only if `status=="SUCCEEDED"`,
   `s3Key` present, and `analyticsStatus` absent. (The read is a fast-path skip;
   the *atomic* gate is step 3.)
3. Conditional write `analyticsStatus: RUNNING` with condition
   **`{ analyticsStatus: { attributeExists: false } }`** (Amplify
   `ModelJobConditionInput` → `attribute_not_exists`). DynamoDB makes this atomic:
   of N duplicate EventBridge deliveries (at-least-once × reservedConcurrency 3),
   exactly one wins; the rest get `ConditionalCheckFailed` → logged no-op. Writing
   `RUNNING` before compute prevents FE subscription regression.
4. `s3:GetObject` + parse the scrape JSON.
5. Compute §4 analytics: one streaming partition pass (language / `voted_up` /
   acquisition / early-access), one NLTK POS+collocation pass per word-list
   partition.
6. Conditional write `analyticsStatus: SUCCEEDED` + `analyticsJson` (guard
   `{ analyticsStatus: { eq: "RUNNING" } }`); minimal input, full response
   selectionSet (§3).
7. On caught error → `analyticsStatus: FAILED` + `analyticsErrorMessage` (§8).

**Empty data is not an error.** `hasData` is precisely `len(reviews) > 0`. A
0-review scrape → `SUCCEEDED`, `hasData:false`, empty arrays. Per-section emptiness
is independent (e.g. `englishReviewCount < 20` empties the NLP word/sentiment
sections while the language-agnostic helpful-reviews section still populates).

---

## §8. Error taxonomy (closed `analyticsErrorMessage` set)

| `analyticsErrorMessage` | Condition |
|---|---|
| `"Couldn't read scrape data."` | S3 `GetObject` or JSON-parse failure. |
| `"Analytics failed."` | Catch-all for any other exception. |

Zero/insufficient reviews are **not** errors (§7). Retries: AppSync 1 retry on
5xx/network (4xx not retried); S3 boto3 standard (3 attempts); async
`retryAttempts:0` (DLQ catches hard crashes). Failed terminal write →
`worker_failed_terminal_write_failed`, exit non-zero.

---

## §9. Observability

Structured JSON logs, `jobId` per line. **Collapsed vocabulary** (per simplicity
review): a single `worker_skipped` event carries a `reason`
(`no_jobid`/`no_row`/`not_succeeded`/`already_started`/`no_s3key`); `worker_running`;
`worker_complete` (with per-stage timings + `hasData`); `worker_empty`;
`worker_s3_read_failed`; `worker_failed`; `worker_failed_terminal_write_failed`;
plus AppSync client events. (No per-analytic `*_complete` events.)

**Deferred (not built):** an `AnalyticsWatchdog` for jobs whose `ScrapeSucceeded`
event was lost. Such a job shows the scrape result with no analytics section (§10).

---

## §10. Frontend display

New analytics section on the nominal `JobPage`, gated on `analyticsStatus`. `Job`
type + `toJobView` extend with the three fields. **The `null`/absent state is
distinct from `RUNNING`** (round-1 fix: lumping them showed a perpetual spinner for
lost-event jobs):

- absent → **no analytics section** (scrape result only; matches §9 lost-event).
- `RUNNING` → "Analyzing reviews…" indicator.
- `SUCCEEDED` + `hasData` → dashboard (NLP sub-sections honor the §4 English gate).
- `SUCCEEDED` + `!hasData` → "Not enough reviews to analyze."
- `FAILED` → unobtrusive "Analytics unavailable." (never breaks the scrape view).

**Dashboard layout — grid (chosen via visual companion):** the existing scrape
summary (header image, review count, % positive) stays untouched on top. Below it,
the analytics section is:
1. **Sentiment-over-time** chart, **full-width** across the top of the section:
   line (weekly buckets) + review-volume bars on a shared time axis, a
   weekly/monthly toggle (monthly derived FE-side), and a "based on the most recent
   N reviews" caption when `!coversFullHistory`.
2. Beneath it, a **responsive 2-column grid** (collapses to one column on narrow
   viewports): **left** = word association (praise vs complaint columns + an
   "overall" toggle); **right** = most-helpful reviews (positive / negative cards,
   ≤3 each, with helpful/funny counts, playtime, and a `language` label).

**Charting:** add **Recharts** (one dual-axis time series with a toggle — a
declarative chart lib is genuinely simpler than hand-rolled SVG here; panel
concurred). `FakeAmplifyClient` extends to simulate the `analyticsStatus` lifecycle
with a fixture payload so the dashboard is exercisable locally with no AWS.

---

## §11. Testing

- **Worker (pytest):** each analytic against a **real scraped S3 fixture** plus
  synthetic edge cases — zero reviews, `englishReviewCount` 0 and just-below/at 20,
  all-positive (empty complaint lists), helpful-rank ties, <3 helpful, single-bucket
  span, **year-boundary span (ISO week-year)**, >10k-implying
  `coversFullHistory:false`. Deterministic (UTC bucketing, mocked S3/AppSync).
  `ruff`.
- **NLTK smoke test (CI, network disabled):** actually call `sent_tokenize` /
  `pos_tag` / a collocation finder against the bundled `NLTK_DATA` to catch the
  data-package-rename failure before deploy.
- **CDK (unit):** rule filter, Lambda config, S3 grant scoped to `jobs/*`, DLQ +
  alarms.
- **FE:** `parseAnalytics` tolerance; dashboard across every `analyticsStatus`
  state incl. absent vs RUNNING and the English-gate empty state; `vitest`
  (`pool: 'forks'` on Windows).
- **E2E (AWS CLI):** real staging scrape → row gains `analyticsStatus:SUCCEEDED` +
  `analyticsJson` → FE renders. Watch CloudWatch/DynamoDB alongside any browser-
  agent validation to separate FE vs backend timing.

---

## §12. Deployment

New `.github/workflows/analytics-deploy.yml` (OIDC): `pytest` + `ruff` + the NLTK
smoke test → build the ZIP asset (vendor `nltk`, fetch the pinned data packages
into `build/`) → CDK unit tests + `cdk deploy` (reads scraper + app SSM at synth).
Separate stack; no Docker. Deploy order per §6.1.

---

## §13. Documentation updates (part of the work)

Rewrite `analytics/docs/ARCHITECTURE.md` + `CONTEXT.md` to the as-built single-
Lambda design; add `analytics/docs/API_CONTRACT.md` (§3 fields, §5 payload,
consumed-event contract); reconcile `docs/OVERVIEW.md` (Phase 2 = analytics only);
update `scraper/docs/API_CONTRACT.md` §5 (new `bucketName` param; summary-call fold
if §2-B verifies).

---

## §14. Decisions resolved at spec-review gate
1. **Scope of extras — RESOLVED.** Keep volume overlay + praise/complaint split;
   **cut** sentiment momentum and the context-cuts bundle (§4, §5, §10 patched).
2. **`fetch_review_summary` fold — RESOLVED.** Dropped; comment-only (§2-B).

Remaining minor defaults (call out if you disagree, else they stand):
3. Weekly buckets stored; monthly **derived FE-side** (not stored; not sliding).
4. Helpful reviews **language-agnostic**, labeled with `language` (not English-only).
5. Review text **capped at 1,000 chars** in the payload.

---

## §15. DA panel resolution log (round 1)

**Patched (correctness):** absent-attribute guard via `attributeExists:false` (§7);
`allTime*`→`analyzed*` + `coversFullHistory` for the 10k-cap honesty defect
(§4/§5); min-English gate of 20 (§4/§10); ISO week-year keying + UTC bucketing
(§4); PMI `apply_freq_filter` (§4.2); exact NLTK data-package names + version pin +
no-network smoke test (§6/§11); playtime minutes→hours in `HelpfulReview` (§5);
`null`-vs-`RUNNING`
FE states (§10); mutation-input-vs-response-selectionSet clarification (§3);
`hasData := len(reviews)>0` (§7).

**Patched (blast radius):** precursor split into app/scraper PRs with deploy-order
preserved (§2); new `scraper/bucketName` SSM param made an explicit scraper-PR
change (§2-B/§6.1); scraper `_JOB_FIELDS` aligned (§2-B); EventBridge rule
documented as name-bound, not CFN-import (§6); S3 bucket-policy pre-check (§6.1).

**Patched (simplicity, non-conflicting):** dropped `schemaVersion`; one time-
granularity (weekly) with FE-derived monthly; collapsed log vocabulary; kept
Recharts + error taxonomy + deferred-watchdog note (panel concurred these earn
their keep).

**Resolved by user at spec-review gate:** the two simplicity scope-blockers —
extras trimmed to volume + praise/complaint (momentum & context-cuts cut), and the
`fetch_review_summary` fold dropped (comment-only). Spec patched accordingly (§4,
§5, §10, §11, §2-B, §14).

**Note:** round-1 also added an "API-key SSM drift" fix and an `a.enum()`
`analyticsStatus`; both were **wrong** and are corrected in §16 below.

---

## §16. Plan-DA resolution log (app-precursor) — corrects round-1 errors

The app-precursor plan's DA panel surfaced two issues that **invalidated round-1
spec decisions** (verified against code, then corrected):

- **API-key SSM drift was a FALSE POSITIVE — fix removed.** `app/amplify/backend.ts:14-24`
  already creates `/reviewlensai/appsync/{url,apiKey}` as CFN-managed
  `StringParameter`s, kept in lockstep with the API on every deploy. The round-1
  confirmation only inspected `app-deploy.yml` (which republishes solely the
  hosting URL) and missed the backend-stack params. The proposed `put-parameter
  --overwrite` step would have added a harmful second writer to a CFN-managed
  param. **§2-A.3 step deleted**; at most a read-only assertion is warranted.
- **`analyticsStatus` changed `a.enum()` → `a.string()`.** An enum field's generated
  condition input lacks `attributeExists`, so the §7 `attribute_not_exists` guard
  was unbuildable. `a.string()` (→ `ModelStringInput`) exposes `attributeExists`.
  Closed value set now enforced by worker + FE union type (§3).
- **Acceptance gate simplified:** dropped the SDL before/after diff and the
  guard-miss log-grep (the live conditional scrape is a strictly stronger proof;
  DynamoDB condition semantics are unaffected by a client/backend bump). Kept the
  table-replacement check + live scrape; added a pre-merge sandbox introspection to
  confirm `analyticsStatus`→`ModelStringInput` and `ModelJobConditionInput` name
  intact (§2-A.4). Validation is now **sandbox pre-merge + live scrape post-merge
  with a revert rollback**, not an unmerged-branch deploy onto live staging.

**Outstanding blockers:** none.
