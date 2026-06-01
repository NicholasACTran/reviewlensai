# Phase 1 Design — Scraper + Basic App

**Status:** Reviewed (DA rounds 1–2 resolved, blocker-free) — ready for user review → implementation plan
**Date:** 2026-06-01
**Scope:** One contract-first spec covering two domains built in parallel — the **scraper** (Python Lambdas + S3) and the **app** (Amplify Gen 2 + React) — coupled by a shared `Job` row.

> Revision history is at the end (§12). This is v2, incorporating the Devil's-Advocate panel (correctness / blast-radius / simplicity).

---

## 1. Goals & non-goals

### Goals
- A user pastes a Steam game store URL, the system validates it, scrapes the game's metadata and up to 10,000 reviews into S3, and the app shows a nominal "it worked" screen: game name, total review count, percent positive (plus header image and price as cheap extras).
- Establish the durable cross-domain **`Job` contract** that Phase 2 (analytics) and Phase 3 (chat) will reuse.

### Non-goals (explicitly deferred)
- AWS Batch / Fargate / ECR (replaced by Lambda).
- `JobWatchdog` Lambda **and any server-side stuck-job sweep** (replaced by in-Lambda failure handling + DLQ + a client-side staleness timeout — see §4.2, §5.2).
- Reviewer country/location (not exposed by Steam; swapped for review `language`).
- Analytics/chat fields on the `Job` row (`analyticsStatus`, `chatStatus`, `ChatMessage`).
- FE-readable S3 (the nominal screen is satisfied entirely by `Job`-row fields; `s3Key` is an internal pointer for Phase 2 — see §3).
- Auth (PoC: none).

---

## 2. Architecture overview

```
FE (React/Vite on Amplify)  ──POST──►  Validator Lambda (Function URL)
        ▲                                   │ create Job(PENDING), async-invoke (passes appdetails payload)
        │ observeQuery (real-time)          ▼
   AppSync + DynamoDB  ◄──mutations──  Scraper Lambda (async) ──► S3 (jobs/{jobId}/{appId}.json)
                                            └──► EventBridge (custom bus): ScrapeSucceeded  [Phase 2 trigger]
```

- **App domain** owns the Amplify Gen 2 backend: the `Job` Data model (→ AppSync API + DynamoDB table), Amplify Hosting, and all UI.
- **Scraper domain** owns two Lambdas, the S3 bucket, the Function URL, the custom EventBridge bus + event, and a DLQ — all via CDK (TypeScript).
- The two domains communicate only through the `Job` row and a handful of SSM parameters.

---

## 3. The `Job` contract (the seam)

DynamoDB row, defined via Amplify Data schema. Single auth mode `allow.publicApiKey()` (used by the browser, the Validator, and the Scraper). Backend writers (Python) mutate via a **raw HTTPS POST to the AppSync GraphQL endpoint with the `x-api-key` header** — no SigV4/IAM signing. The FE subscribes with `client.models.Job.observeQuery({ id })`.

| Field | Type | Owner (sole writer) | Notes |
|---|---|---|---|
| `id` | string (PK) | Validator | jobId (uuid/ULID) |
| `status` | enum `PENDING\|RUNNING\|SUCCEEDED\|FAILED` | Validator (PENDING), Scraper (rest) | lifecycle; transitions are conditional |
| `steamUrl` | string | Validator | raw input (normalized) |
| `appId` | string | Validator | parsed from URL |
| `gameName` | string | Validator (seed) | from `appdetails`; display-only (S3 is canonical) |
| `headerImage` | string (url) | Validator (seed) | display-only |
| `price` | string (nullable) | Validator (seed) | display string; null for free games |
| `totalReviews` | int | Scraper | **true** total from `query_summary` (not the capped count) |
| `pctPositive` | float **(nullable)** | Scraper | `total_positive/total_reviews` from `query_summary`; **`null` iff `totalReviews == 0`** |
| `scrapedReviews` | int | Scraper | count of unique reviews actually stored (≤ 10k; may be < `totalReviews`) |
| `s3Key` | string | Scraper | `jobs/{jobId}/{appId}.json`; **internal pointer for Phase 2, not FE-readable in Phase 1** |
| `errorMessage` | string (closed set) | Validator (on `PENDING→FAILED`) **or** Scraper (on `RUNNING→FAILED`) | set on FAILED only; one of the §7 strings. Ownership is partitioned by guarded transition (§3.1) |
| `createdAt` / `updatedAt` | datetime | Amplify-managed | |
| `expiresAt` | int (epoch) | Validator | TTL attribute, ~30 days out; also reclaims orphan rows |

### 3.1 Write ownership & concurrency (normative)
The `Job` row is shared by multiple writers now (Validator, Scraper) and more later (Phase 2 analytics, Phase 3 chat). To keep the row safe to extend without re-architecture:
- **Each field has one writer per source-state-guarded transition** (the "Owner" column above). Ownership is partitioned by *guarded transition*, not globally: e.g. `errorMessage` is written by the Validator on `PENDING→FAILED` and by the Scraper on `RUNNING→FAILED`, but the two can never both fire because each is guarded on a different, mutually-exclusive source state. A writer **only ever sends the fields it owns for that transition** in a mutation; it never includes fields it doesn't own.
- **No writer does a read-modify-write of a field it doesn't own.** Mutations carry literal new values, not a re-serialized full row.
- **All status transitions are conditional**, and the guard serializes concurrent writers:
  - `PENDING→RUNNING` (Scraper) — guarded on `status == PENDING`.
  - `PENDING→FAILED` (Validator, on invoke failure — §4.1 step 5) — guarded on `status == PENDING`.
  - `RUNNING→SUCCEEDED` and `RUNNING→FAILED` (Scraper) — guarded on `status == RUNNING`.
  - A guard miss is a no-op, never an overwrite. The two `PENDING→*` transitions race only in the rare invoke-ambiguity case (Validator believes the async invoke failed but AWS actually accepted it and the Scraper started); whichever conditional write commits first wins, and the loser no-ops — so the row never ends in an inconsistent state.
- **Every backend `updateJob` returns the full `Job` selectionSet** so the FE's `observeQuery` merge never sees a field omitted-as-null.
- Phase 2/3 add their own owned fields under the same rules — additive, never touching Phase 1 fields.

### Status lifecycle
`PENDING` (Validator created row) → `RUNNING` (Scraper started) → `SUCCEEDED` (S3 written, fields populated) **or** `FAILED` (scrape error). The row exists only *after* validation passes.

---

## 4. Scraper domain

### 4.1 Validator Lambda
- **Trigger:** public Function URL (`AuthType: NONE`), CORS allow-list from SSM `/reviewlensai/amplify/url`. 10s timeout. (Note: CORS restricts browsers only; see §11 for the abuse posture and the Scraper reserved-concurrency guardrail.)
- **Logic:**
  1. **Shape check** (no network): URL parses, host is `store.steampowered.com`, path matches `/app/(\d+)`. Extract `appId`. Fail → `400 { error: "That's not a Steam game URL." }`.
  2. **Existence check** (one call): `GET store.steampowered.com/api/appdetails?appids={appId}&cc=us&l=english`. Require `body[appId].success === true` (lenient on `type`). Fail / network error / region-locked `success:false` → `400 { error: "We couldn't find that game on Steam." }`.
  3. Generate `jobId`. Create `Job(PENDING)` via `createJob`, seeded with `gameName`, `headerImage`, `price` from the `appdetails` payload.
  4. **Async-invoke** the Scraper (`InvocationType: Event`) with `{ jobId, appId, appdetails: <the payload already fetched in step 2> }` so the Scraper does **not** re-hit `appdetails`. (Payload ~28 KB, well under the 256 KB async limit.)
  5. On invoke success → return `200 { jobId }`. **On invoke failure** → perform the `PENDING→FAILED` transition (guarded on `status == PENDING`, §3.1) with `errorMessage = "Couldn't start the scrape. Try again."`, and still return `200 { jobId }`, so the FE lands on the Try-Again screen via the normal path. If the invoke was actually accepted (ambiguous failure) and the Scraper already moved the row to `RUNNING`, this guarded write **no-ops** and the real scrape proceeds — no orphan PENDING; TTL reclaims any straggler.
- Validation errors (steps 1–2) are **synchronous** HTTP 4xx — no Job row created.

### 4.2 Scraper Lambda
- **Trigger:** async invoke from Validator only. Memory 1024 MB, timeout 600s (realistic run ~2.5 min), **async retry attempts = 0**, on-failure destination = **DLQ (SQS)**, **reserved concurrency = 3** (bounds runaway/abuse cost and concentrated Steam egress).
- **Idempotency:** first action is the conditional `PENDING→RUNNING` transition. Guard miss (duplicate delivery) → no-op exit.
- **Logic:**
  1. `getJob(jobId)`; if missing or not `PENDING`, no-op (logged).
  2. Conditionally mutate → `RUNNING`.
  3. Use the **`appdetails` payload passed in the event** for the full metadata block (name, short/about descriptions, genres, categories, price, header image, release date). No second Steam metadata call. (If the payload is absent — e.g. a manual re-drive — fall back to one `appdetails?cc=us&l=english` fetch; a fetch failure here is **non-fatal**, the seeded Job fields stand and S3 metadata is best-effort.)
  4. **Paginate reviews:** `GET store.steampowered.com/appreviews/{appId}?json=1&num_per_page=100&filter=recent&language=all&purchase_type=all&cursor={url-encoded cursor}`, starting `cursor=*`.
     - Read `query_summary.total_reviews` / `total_positive` from the **first page only** (later pages don't repopulate it).
     - Maintain a `seen` set of `recommendationid`; append only unseen reviews, trimmed to the kept field set (below).
     - **Stop when:** returned `reviews` is empty, **or** the returned `cursor` equals the cursor just used (end-of-stream sentinel), **or** `scrapedReviews` reaches `MAX_REVIEWS` (env, default 10000).
     - `scrapedReviews` = number of unique stored reviews (may be `< totalReviews`; that's a valid SUCCEEDED).
     - Polite ~0.5–1 s delay between pages; on HTTP 429/5xx, exponential backoff (max 3 tries/page) within the wall budget. If a review page returns `success:false` (age/region edge the Validator missed) → FAILED `"Couldn't read Steam reviews. Try again."`.
  5. Write `jobs/{jobId}/{appId}.json` to S3 (canonical): `{ game: {...metadata}, summary: {totalReviews, totalPositive, pctPositive}, reviews: [...] }`.
  6. Conditionally mutate → `SUCCEEDED` with `totalReviews`, `pctPositive` (null iff 0), `scrapedReviews`, `s3Key`.
  7. Emit `ScrapeSucceeded` on the **custom `reviewlensai` bus** (`Source: "reviewlensai.scraper", DetailType: "ScrapeSucceeded", Detail: { jobId: string, appId: string, s3Key: string }`). **This emit is non-fatal** — a `PutEvents` failure is logged but does not fail the (already SUCCEEDED) job.
- **Kept review fields:** `recommendationid, language, review, timestamp_created, timestamp_updated, voted_up, votes_up` (→ PRD "found this review helpful"), `votes_funny, steam_purchase, received_for_free, written_during_early_access, author.{playtime_at_review, playtime_forever}`. (Drops avatars, reactions, weighted_vote_score, profile URLs.)
- **Error taxonomy** (closed set in `errorMessage`, never raw exceptions):
  - `"Couldn't reach Steam. Try again."` — network/HTTP failure contacting Steam.
  - `"Couldn't read Steam reviews. Try again."` — `appreviews success:false` mid-scrape.
  - `"Couldn't start the scrape. Try again."` — Validator-side invoke failure (set by Validator, §4.1).
  - `"Scrape failed. Try again."` — catch-all (S3 write failure, unexpected error).
  - On any failure: conditionally mutate → `FAILED`. If the FAILED write itself fails, let the invocation error → DLQ (alarmed, §4.4).
- **No server-side sweep.** Soft failures are handled by the in-Lambda `try/except → FAILED`; hard crashes go to the DLQ (alarmed). The FE provides a **client-side staleness timeout** (§5.2) so the user is never stuck on a spinner. (A server-side janitor is revisited in Phase 2+ when concurrency is real.)

### 4.3 Storage
- S3 bucket, `BlockPublicAccess: ALL`, 30-day lifecycle on `jobs/*`. Phase 1 only writes; Phase 2 analytics is the first reader (its IAM read grant is a Phase 2 concern).
- CloudWatch logs (14-day retention) on both Lambdas, structured JSON with `jobId` per line.

### 4.4 CDK resources (`scraper/cdk/`)
- Validator Lambda + Function URL; Scraper Lambda + DLQ + async-config (retries 0, on-failure → DLQ) + reserved concurrency 3.
- S3 bucket (+ lifecycle). Custom EventBridge bus `reviewlensai` (+ SSM export of its name/ARN).
- Log groups.
- **Alarms:** CloudWatch alarm on DLQ `ApproximateNumberOfMessagesVisible > 0` and on Scraper Lambda `Errors`, wired to an SNS topic (no subscription required for the PoC — alarm state is the signal). Runbook note: a Scraper **throttle** (reserved-concurrency=3 exhausted) surfaces as a Validator-observed invoke failure → user Try-Again, and does **not** reach the DLQ (the DLQ only catches accepted-then-crashed async invocations) — so an empty DLQ during a throttle storm is by design.
- **IAM:** Validator: `lambda:InvokeFunction` on the Scraper. Scraper: `s3:PutObject` on the bucket, `events:PutEvents` on the `reviewlensai` bus. **Backend AppSync writes use the API key (x-api-key), not IAM** — so neither Lambda needs an `appsync:GraphQL` grant. SSM reads/writes per §6.

---

## 5. App domain

### 5.1 Amplify Gen 2 backend (`app/amplify/`)
- Data schema defines `Job` (§3); `pctPositive` and `price` are **nullable** (`a.float()`, `a.string()` — not `.required()`). Generates AppSync API + DynamoDB table (PAY_PER_REQUEST, TTL on `expiresAt`).
- Publishes SSM params (§6) at deploy.
- **API-key TTL:** Amplify API keys expire (≤365 days). Set the max TTL and treat key expiry as a known Open Risk (§11) — silent write failures if it lapses.

### 5.2 Frontend (`app/src/`, React + Vite)
- **Routes:** `/` (URL Box), `/job/:id` (waiting → nominal / try-again).
- **URL Box:** controlled input + Analyze → POST to `VITE_VALIDATOR_URL`. On 4xx, render the returned `error` inline. On 200, navigate to `/job/{jobId}`. If `VITE_VALIDATOR_URL` is unset (cold bootstrap), show a friendly "not yet configured" state.
- **Job view:** `client.models.Job.observeQuery({ id })` returns an `items` array; treat `items.length === 0` as **"still waiting"** (not "not found") and render from `items[0]` once present.
  - `PENDING`/`RUNNING` → animated waiting screen, with a **client-side staleness timeout**: if no transition for N minutes (e.g. 12), show the Try-Again screen. **N must be strictly greater than the Scraper's 600s timeout plus margin** (cold start + backoff + subscription propagation) so a slow-but-succeeding job never shows Try-Again moments before the row flips `SUCCEEDED`.
  - `SUCCEEDED` → nominal screen: `gameName`, `totalReviews`, `pctPositive` (or "N/A" when null/0), `headerImage`, `price`.
  - `FAILED` → Try-Again screen showing `errorMessage`, button returns to `/`.
- **Local-sim (two transports, not redundant):** MSW mocks the Validator **HTTP** call; `FakeAmplifyClient` fakes the AppSync **WebSocket** `observeQuery` lifecycle (`PENDING→RUNNING→SUCCEEDED` on a timer) — the real-time subscription can't be cleanly intercepted at the network layer, so the two fakes cover genuinely different transports. `npm run dev` touches zero AWS.

---

## 6. Cross-domain contract (SSM)

| Parameter | Producer | Consumer | Purpose |
|---|---|---|---|
| `/reviewlensai/appsync/url` | app | scraper | AppSync endpoint for `x-api-key` mutations |
| `/reviewlensai/appsync/apiKey` | app | scraper | API-key auth for backend writers |
| `/reviewlensai/amplify/url` | app | scraper | Validator CORS allow-list + Playwright base URL |
| `/reviewlensai/scraper/eventBusName` | scraper | (Phase 2) | name of the `reviewlensai` bus the analytics rule binds to |

`/reviewlensai/appsync/apiId` is **dropped** — it existed only to build IAM field-ARNs, which the API-key auth model doesn't need.

**Bootstrap / deploy order (hard build dependency):** the scraper reads its SSM params at **synth** time, so the app's AppSync params must exist before `cdk synth`. Order: **(1) deploy app** (creates AppSync + writes `appsync/*`, `amplify/url`) → **(2) deploy scraper** (synth reads those params; creates the Validator Function URL) → **(3) set the Amplify branch env `VITE_VALIDATOR_URL` and rebuild the app**. A mid-sequence failure leaves the FE's "not yet configured" state (§5.2), not a hard break. The runbook documents this explicitly.

---

## 7. Error handling summary

| Channel | Surface | Examples |
|---|---|---|
| ① Sync validation | Validator 4xx, no Job row, FE inline form error | "Enter a valid URL." / "That's not a Steam game URL." / "We couldn't find that game on Steam." |
| ② Async scrape | `Job.FAILED` + `errorMessage`, FE Try-Again screen | "Couldn't reach Steam. Try again." / "Couldn't read Steam reviews. Try again." / "Couldn't start the scrape. Try again." / "Scrape failed. Try again." |

Zero-review game → `SUCCEEDED`, `totalReviews: 0`, `pctPositive: null`, nominal screen shows "0 reviews / N/A".

---

## 8. Testing

- **Unit (scraper):** URL parse/validation; appdetails existence (incl. `success:false`); pagination + cap + **dedup + stop-condition** logic; field trimming; S3 payload shape; Job mutation client (incl. **zero-review payload with `pctPositive: null` is accepted**); error taxonomy; invoke-failure path (incl. the guarded `PENDING→FAILED` write **no-ops** when the row is already `RUNNING`/`SUCCEEDED`). Fixtures are **real captured Steam responses** (appreviews + appdetails), not synthesized.
- **Unit (app):** URL Box validation rendering; Job-view state machine (waiting/nominal/try-again, `items: []` waiting, staleness timeout) against `FakeAmplifyClient`; MSW-backed Validator calls.
- **Staging E2E:**
  - AWS-CLI happy path: curl Validator URL → poll `getJob` to `SUCCEEDED` → confirm S3 object.
  - **Playwright PM agent** (`.claude/agents/phase1-pm.md`): drives paste→waiting→nominal in a real browser, plus invalid-URL and forced-failure paths. Run is **paired with live observation** of Scraper logs + Job-row transitions so FE-render lag vs backend lag is diagnosable. Screenshots → top-level `screenshots/` (gitignored).

---

## 9. Deployment (GitHub Actions, per domain)

- **App workflow:** Amplify Gen 2 pipeline (backend + hosting) on push to app paths; publishes SSM params.
- **Scraper workflow:** CDK deploy on push to scraper paths; after deploy, writes `VITE_VALIDATOR_URL` to the Amplify branch env and triggers an app rebuild.
- Deliverable: **`scraper/docs/API_CONTRACT.md`** — the canonical `Job` field contract + the `ScrapeSucceeded` event schema (referenced by the PRD/OVERVIEW; consumed by Phase 2/3).
- Feature branch per the CLAUDE.md workflow; full CI locally before shepherding to staging. No production environment (PoC).

---

## 10. Repo layout

```
scraper/
  src/            # validator/, scraper/, shared (appsync client, steam client, log)
  cdk/            # CDK app + stack
  tests/          # unit + fixtures (real Steam JSON)
  docs/API_CONTRACT.md
app/
  amplify/        # Gen 2 backend (data schema)
  src/            # React app, routes, FakeAmplifyClient, MSW handlers
  tests/
.claude/agents/phase1-pm.md
docs/             # this spec, OVERVIEW, PRDs
```

---

## 11. Open risks & posture

- **Public surface (abuse/cost):** the Function URL is `AuthType: NONE` and the AppSync API key ships in the FE bundle, so anyone can trigger scrapes or read/mutate `Job` rows. PoC-acceptable (no PII), bounded by **Scraper reserved-concurrency = 3** so a flood can't run unbounded; the dominant real risk is concentrated Steam egress getting the Lambda IP rate-limited. Revisit (Cognito / WAF rate rule) before any public launch.
- **Steam ToS / legal posture:** the product is built on scraped Steam UGC. For this PoC the data is **internal/demo-only, not redistributed**, stored ≤30 days, trimmed to needed fields, with polite delays + backoff partly as ToS courtesy. Productionization requires a ToS/licensing/data-protection review. (Noted so it isn't sleepwalked into Phase 4.)
- **API-key expiry:** Amplify API keys expire (≤365 days); lapse → silent backend-write failure. Set max TTL; track renewal.
- **Lambda 15-min ceiling** caps future scrape depth (~30–40k reviews); revisit compute (Batch/Step Functions) if the cap is raised materially.
- **`appdetails` regional/age-gate** edge cases → treated as "not found" (Validator) or non-fatal metadata fallback (Scraper).
- **Async-invoke duplicate delivery** → mitigated by the `PENDING`-guarded `RUNNING` transition.

---

## 12. Revision history

- **v2.1 (2026-06-01)** — DA round-2 verification resolved two new blockers the v2 invoke-failure path introduced: added the `PENDING→FAILED` guarded transition to §3.1 and **partitioned field ownership by guarded transition** (so `errorMessage` can be written by the Validator on `PENDING→FAILED` and the Scraper on `RUNNING→FAILED` without violating single-writer safety). Also: staleness-timeout margin note (§5.2), guarded-no-op unit test (§8), and a throttle-vs-DLQ runbook note (§4.4). Round-2 verifier confirmed no further blockers.
- **v2 (2026-06-01)** — Devil's-Advocate panel (correctness / blast-radius / simplicity) resolved:
  - **Removed** the server-side scheduled stuck-RUNNING sweep (race + complexity); replaced with in-Lambda `FAILED` + DLQ alarm + FE client-side staleness timeout.
  - **`pctPositive`/`price` pinned nullable**; documented `pctPositive` is over the true `query_summary` total; added zero-review acceptance test.
  - Added **§3.1 write-ownership & concurrency** (single-writer fields, conditional transitions, no foreign read-modify-write, full selectionSet).
  - **Eliminated the duplicate `appdetails` fetch** — Validator passes its payload to the Scraper via the invoke event; pinned `cc=us&l=english`; declared S3 metadata canonical / Job seed display-only.
  - Specified **cursor pagination** termination (dedup by `recommendationid`, stop on empty/repeated cursor, URL-encode) and an `appreviews success:false` branch; defined `scrapedReviews < totalReviews` as a valid SUCCEEDED.
  - Fixed the **auth-model contradiction** (API-key writers need no `appsync:GraphQL` IAM grant; dropped the `apiId` SSM param).
  - Added **reserved concurrency = 3**, **DLQ/error alarms**, a **custom `reviewlensai` EventBridge bus** with a **non-fatal** emit, **orphan-PENDING** handling on invoke failure, **`s3Key` internal-pointer** clarification, **ToS/legal posture** + **API-key-TTL** risks, **observeQuery `items: []`** handling, and **`API_CONTRACT.md`** as a deliverable.
- **v1 (2026-06-01)** — initial design from brainstorming.
