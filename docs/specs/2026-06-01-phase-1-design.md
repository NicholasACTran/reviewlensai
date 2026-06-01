# Phase 1 Design — Scraper + Basic App

**Status:** Draft (pending Devil's-Advocate review)
**Date:** 2026-06-01
**Scope:** One contract-first spec covering two domains built in parallel — the **scraper** (Python Lambdas + S3) and the **app** (Amplify Gen 2 + React) — coupled by a shared `Job` row.

---

## 1. Goals & non-goals

### Goals
- A user pastes a Steam game store URL, the system validates it, scrapes the game's metadata and up to 10,000 reviews into S3, and the app shows a nominal "it worked" screen: game name, total review count, percent positive (plus header image and price as cheap extras).
- Establish the durable cross-domain **`Job` contract** that Phase 2 (analytics) and Phase 3 (chat) will reuse.

### Non-goals (explicitly deferred)
- AWS Batch / Fargate / ECR (replaced by Lambda).
- `JobWatchdog` Lambda (replaced by in-Lambda failure handling + DLQ).
- Reviewer country/location (not exposed by Steam; swapped for review `language`).
- Analytics/chat fields on the `Job` row (`analyticsStatus`, `chatStatus`, `ChatMessage`).
- Auth (PoC: none).

---

## 2. Architecture overview

```
FE (React/Vite on Amplify)  ──POST──►  Validator Lambda (Function URL)
        ▲                                   │ create Job(PENDING), async-invoke
        │ observeQuery (real-time)          ▼
   AppSync + DynamoDB  ◄──mutations──  Scraper Lambda (async) ──► S3 (jobs/{jobId}/{appId}.json)
                                            └──► EventBridge: ScrapeSucceeded (for Phase 2)
```

- **App domain** owns the Amplify Gen 2 backend: the `Job` Data model (→ AppSync API + DynamoDB table), Amplify Hosting, and all UI.
- **Scraper domain** owns two Lambdas, the S3 bucket, the Function URL, the EventBridge event, and a DLQ — all via CDK (TypeScript).
- The two domains communicate only through the `Job` row and a handful of SSM parameters.

---

## 3. The `Job` contract

DynamoDB row, defined via Amplify Data schema. Single auth mode `allow.publicApiKey()` (used by the browser, the Validator, and the Scraper). Backend writers mutate via AppSync over HTTPS with the `x-api-key` header. The FE subscribes with `client.models.Job.observeQuery({ id })`, which maintains a merged synced view (correct for a multi-writer row — we never hand-roll an `onUpdate` that replaces state).

| Field | Type | Set by | Notes |
|---|---|---|---|
| `id` | string (PK) | Validator | jobId (ULID/uuid) |
| `status` | enum `PENDING\|RUNNING\|SUCCEEDED\|FAILED` | both | lifecycle |
| `steamUrl` | string | Validator | raw input (normalized) |
| `appId` | string | Validator | parsed from URL |
| `gameName` | string | Validator (seed) | from `appdetails` |
| `headerImage` | string (url) | Validator (seed) | cheap extra |
| `price` | string | Validator (seed) | display string, nullable (free games) |
| `totalReviews` | int | Scraper | true total from `query_summary` |
| `pctPositive` | float | Scraper | `total_positive / total_reviews` (null if 0 reviews) |
| `scrapedReviews` | int | Scraper | count actually stored (≤ 10k) |
| `s3Key` | string | Scraper | `jobs/{jobId}/{appId}.json` |
| `errorMessage` | string | Scraper | constrained string, set on FAILED only |
| `createdAt` / `updatedAt` | datetime | Amplify-managed | |
| `expiresAt` | int (epoch) | Validator | TTL attribute, ~30 days out |

### Status lifecycle
`PENDING` (Validator created row) → `RUNNING` (Scraper started) → `SUCCEEDED` (S3 written, fields populated) **or** `FAILED` (scrape error). The row exists only *after* validation passes.

---

## 4. Scraper domain

### 4.1 Validator Lambda
- **Trigger:** public Function URL (`AuthType: NONE`), CORS allow-list from SSM `/reviewlensai/amplify/url`. 10s timeout.
- **Logic:**
  1. **Shape check** (no network): URL parses, host is `store.steampowered.com`, path matches `/app/(\d+)`. Extract `appId`. Fail → `400 { error: "That's not a Steam game URL." }`.
  2. **Existence check** (one call): `GET store.steampowered.com/api/appdetails?appids={appId}&cc=us`. Require `body[appId].success === true`. Lenient on `type` (accept any success). Fail / network error → `400 { error: "We couldn't find that game on Steam." }`.
  3. Create `Job(PENDING)` via AppSync `createJob`, seeded with `gameName`, `headerImage`, `price` from the `appdetails` payload.
  4. **Async-invoke** the Scraper Lambda (`InvocationType: Event`) with `{ jobId, appId }`.
  5. Return `200 { jobId }`.
- **Validation errors are synchronous** (HTTP 4xx) — no Job row is created for them.

### 4.2 Scraper Lambda
- **Trigger:** async invoke from Validator only. Memory 1024 MB, timeout 600s (10 min; realistic run ~2.5 min), **async retry attempts = 0**, on-failure destination = **DLQ (SQS)**.
- **Idempotency:** first action is a conditional transition to `RUNNING` guarded on `status == PENDING`. If the guard fails (duplicate delivery), exit no-op.
- **Logic:**
  1. `getJob(jobId)`; if missing or not `PENDING`, no-op (logged).
  2. Mutate → `RUNNING`.
  3. Re-fetch `appdetails` for the full metadata block (name, short/about descriptions, genres, categories, price, header image, release date).
  4. Paginate `appreviews/{appId}?json=1&num_per_page=100&filter=recent&language=all&purchase_type=all&cursor=…` following `cursor`, trimming each review to the kept field set (below), until `MAX_REVIEWS` (env, default 10000) or reviews exhausted. Read `query_summary.total_reviews` / `total_positive` from the first page.
  5. Write `jobs/{jobId}/{appId}.json` to S3: `{ game: {...metadata}, summary: {totalReviews, totalPositive, pctPositive}, reviews: [...] }`.
  6. Mutate → `SUCCEEDED` with `totalReviews`, `pctPositive`, `scrapedReviews`, `s3Key`.
  7. Emit EventBridge `Source: "reviewlensai.scraper", DetailType: "ScrapeSucceeded", Detail: { jobId, appId, s3Key }`.
- **Kept review fields:** `recommendationid, language, review, timestamp_created, timestamp_updated, voted_up, votes_up, votes_funny, steam_purchase, received_for_free, written_during_early_access, author.{playtime_at_review, playtime_forever}`. (Drops avatars, reactions, weighted_vote_score, profile URLs.)
- **Rate-limiting:** ~0.5–1s polite delay between review pages; on HTTP 429/5xx, exponential backoff (max 3 tries/page) staying within the wall budget.
- **Error taxonomy** (constrained `errorMessage`, never raw exceptions):
  - `"Couldn't reach Steam. Try again."` — network/HTTP failures contacting Steam.
  - `"Scrape failed. Try again."` — catch-all (S3 write failure, unexpected error).
  - On any failure: mutate → `FAILED` with the message. If the FAILED write itself fails, the invocation errors → DLQ.
- **Stuck-RUNNING safety net (lean):** a scheduled EventBridge rule (every 15 min) invokes a tiny inline check that flips rows `RUNNING` with `updatedAt` older than 15 min to `FAILED` (`"Scrape failed. Try again."`). This replaces the JobWatchdog without Batch events.

### 4.3 Storage
- S3 bucket, `BlockPublicAccess: ALL`, 30-day lifecycle on `jobs/*`. Read by the worker for re-fetch is not needed; only writes.
- CloudWatch logs (14-day retention) on both Lambdas, structured JSON with `jobId` per line.

### 4.4 CDK resources (`scraper/cdk/`)
Validator Lambda + Function URL, Scraper Lambda + DLQ + async config, S3 bucket, EventBridge bus usage (default bus), the stuck-RUNNING schedule rule, log groups, IAM (Validator: `lambda:InvokeFunction` on Scraper, `appsync:GraphQL` on `createJob`; Scraper: `s3:PutObject` on bucket, `appsync:GraphQL` on `getJob`/`updateJob`, `events:PutEvents`). SSM reads/writes per §6.

---

## 5. App domain

### 5.1 Amplify Gen 2 backend (`app/amplify/`)
- Data schema defines `Job` (§3). Generates AppSync API + DynamoDB table (PAY_PER_REQUEST, TTL on `expiresAt`).
- Publishes SSM params (§6) at deploy.

### 5.2 Frontend (`app/src/`, React + Vite)
- **Routes:** `/` (URL Box), `/job/:id` (waiting → nominal / try-again).
- **URL Box:** controlled input + Analyze button → POST to `VITE_VALIDATOR_URL`. On 4xx, render the returned `error` inline. On 200, navigate to `/job/{jobId}`.
- **Job view:** subscribes via `client.models.Job.observeQuery({ id })`.
  - `PENDING`/`RUNNING` → animated waiting screen.
  - `SUCCEEDED` → nominal screen: `gameName`, `totalReviews`, `pctPositive` (or "N/A" when 0 reviews), `headerImage`, `price`.
  - `FAILED` → "Try Again" screen showing `errorMessage`, button returns to `/`.
- **Local-sim:** MSW handlers for the Validator URL + a `FakeAmplifyClient` that walks a Job `PENDING→RUNNING→SUCCEEDED` on a timer. `npm run dev` touches zero AWS.

---

## 6. Cross-domain contract (SSM)

| Parameter | Producer | Consumer | Purpose |
|---|---|---|---|
| `/reviewlensai/appsync/url` | app | scraper | AppSync endpoint for mutations |
| `/reviewlensai/appsync/apiId` | app | scraper | field-ARN construction for IAM |
| `/reviewlensai/appsync/apiKey` | app | scraper | API-key auth for backend writers |
| `/reviewlensai/amplify/url` | app | scraper | Validator CORS allow-list + Playwright base URL |

The Validator's Function URL is fed back to the Amplify branch env var `VITE_VALIDATOR_URL` by the scraper deploy workflow after the scraper stack creates the URL. **Deploy order:** app first (produces AppSync params), then scraper (consumes them, produces Validator URL), then app rebuild picks up `VITE_VALIDATOR_URL`.

---

## 7. Error handling summary

| Channel | Surface | Examples |
|---|---|---|
| ① Sync validation | Validator 4xx, no Job row, FE inline form error | "Enter a valid URL." / "That's not a Steam game URL." / "We couldn't find that game on Steam." |
| ② Async scrape | `Job.FAILED` + `errorMessage`, FE Try-Again screen | "Couldn't reach Steam. Try again." / "Scrape failed. Try again." |

Zero-review game → `SUCCEEDED`, `totalReviews: 0`, `pctPositive: null`, nominal screen shows "0 reviews / N/A".

---

## 8. Testing

- **Unit (scraper):** URL parse/validation, appdetails existence handling, pagination + cap logic, field trimming, S3 payload shape, Job mutation client, error taxonomy. Fixtures are **real captured Steam responses** (appreviews + appdetails), not synthesized.
- **Unit (app):** URL Box validation rendering, Job-view state machine (waiting/nominal/try-again) against `FakeAmplifyClient`, MSW-backed Validator calls.
- **Staging E2E:**
  - AWS-CLI happy path: curl Validator URL → poll `getJob` to `SUCCEEDED` → confirm S3 object exists.
  - **Playwright PM agent** (`.claude/agents/phase1-pm.md`): drives paste→waiting→nominal in a real browser, plus invalid-URL and forced-failure paths. Run is **paired with live observation** of Scraper logs + Job-row transitions so FE-render lag vs backend lag is diagnosable. Screenshots → top-level `screenshots/` (gitignored).

---

## 9. Deployment (GitHub Actions, per domain)

- **App workflow:** Amplify Gen 2 pipeline (backend + hosting) on push to the app's paths; publishes SSM params.
- **Scraper workflow:** CDK deploy on push to scraper paths; after deploy, writes `VITE_VALIDATOR_URL` to the Amplify branch env and triggers an app rebuild.
- Feature branch per the CLAUDE.md workflow; full CI locally before shepherding to staging. No production environment (PoC).

---

## 10. Repo layout

```
scraper/
  src/            # validator/, scraper/, shared (appsync client, steam client, log)
  cdk/            # CDK app + stack
  tests/          # unit + fixtures (real Steam JSON)
app/
  amplify/        # Gen 2 backend (data schema)
  src/            # React app, routes, FakeAmplifyClient, MSW handlers
  tests/
.claude/agents/phase1-pm.md
docs/             # this spec, OVERVIEW, PRDs
```

---

## 11. Open risks

- **Steam rate-limiting** at scale of concurrent jobs (single-user PoC → low risk; polite delays + backoff mitigate).
- **`appdetails` regional/age-gate** edge cases → treated as "not found" (acceptable for PoC).
- **Lambda 15-min ceiling** caps future scrape depth (~30–40k reviews); revisit compute if the cap is raised materially.
- **Async-invoke duplicate delivery** → mitigated by the `PENDING`-guarded `RUNNING` transition.
