# Scraper Domain — API Contract

**Version:** 1.0 (Phase 1)
**Spec reference:** `docs/specs/2026-06-01-phase-1-design.md` §3, §3.1, §4.1, §4.2, §7
**Consumers:** App domain (Phase 1), Analytics domain (Phase 2), Chat domain (Phase 3)

This document is the canonical interface definition for everything the Scraper domain exposes. Phase 2 and Phase 3 MUST derive their integration assumptions from this document, not from source code.

---

## 1. Validator Function URL

### Endpoint

```
POST {VITE_VALIDATOR_URL}
Content-Type: application/json
```

The Function URL is resolved at deploy time. Its value is stored in SSM at `/reviewlensai/scraper/validatorUrl` and fed into the Amplify app branch as the `VITE_VALIDATOR_URL` environment variable (see §6 of the spec).

### Request body

```json
{ "url": "https://store.steampowered.com/app/{appId}/{optional-slug}/" }
```

| Field | Type     | Required | Description                                    |
|-------|----------|----------|------------------------------------------------|
| `url` | `string` | yes      | A Steam game store URL with a numeric `appId`. |

### Success response — 200

```json
{ "jobId": "<uuid>" }
```

The `jobId` uniquely identifies the scrape job. Use it to subscribe to `Job` row updates via AppSync `observeQuery`.

### Error responses — 4xx

All validation errors are synchronous. No `Job` row is created.

| HTTP status | `error` value                          | Condition                                                             |
|-------------|----------------------------------------|-----------------------------------------------------------------------|
| `400`       | `"Enter a valid URL."`                 | Request body is not valid JSON or `url` field is absent/null.         |
| `400`       | `"That's not a Steam game URL."`       | URL scheme is not `http`/`https`, host is not `store.steampowered.com`, or path does not match `/app/(\d+)`. |
| `400`       | `"We couldn't find that game on Steam."` | `appdetails` API returned `success: false`, a non-2xx HTTP status, or a network error. |

Error response body shape:

```json
{ "error": "<one of the strings above>" }
```

### CORS

The Function URL's CORS policy allows `POST` and `OPTIONS` from the Amplify origin (`/reviewlensai/amplify/url`). The handler also returns the CORS headers on every response so browsers do not block them.

---

## 2. The `Job` row contract

The `Job` row lives in AppSync + DynamoDB, defined by the App domain's Amplify Data schema. The Scraper domain writes to it over raw HTTPS using the `x-api-key` header — no SigV4/IAM signing required.

### Field table

| Field           | GraphQL type       | Owner (sole writer)                                        | Notes                                                                                                  |
|-----------------|--------------------|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| `id`            | `String` (PK)      | Validator                                                   | `jobId` — a UUID generated at validation time.                                                         |
| `status`        | `PENDING\|RUNNING\|SUCCEEDED\|FAILED` | Validator writes `PENDING`; Scraper writes the rest | All transitions are **conditional** (§2.1 below).                                                     |
| `steamUrl`      | `String`           | Validator                                                   | The raw input URL (as submitted by the user).                                                          |
| `appId`         | `String`           | Validator                                                   | Numeric `appId` parsed from the URL path.                                                              |
| `gameName`      | `String`           | Validator (seed)                                            | From `appdetails`; display-only. The S3 object is canonical for Phase 2+.                             |
| `headerImage`   | `String` (nullable) | Validator (seed)                                           | CDN URL from `appdetails`; display-only.                                                               |
| `price`         | `String` (nullable) | Validator (seed)                                           | Formatted price string (e.g. `"$14.99"`); `null` for free-to-play games.                              |
| `totalReviews`  | `Int`              | Scraper                                                     | **True** total from `query_summary.total_reviews` (a dedicated `filter=all&num_per_page=0` call) — not the capped scrape count. |
| `pctPositive`   | `Float` (nullable) | Scraper                                                     | `total_positive / total_reviews` from `query_summary`. **`null` when `totalReviews == 0`**.            |
| `scrapedReviews`| `Int`              | Scraper                                                     | Count of unique reviews actually stored in S3 (≤ 10,000; may be less than `totalReviews`).            |
| `s3Key`         | `String`           | Scraper                                                     | `jobs/{jobId}/{appId}.json`. **Internal pointer for Phase 2 — not rendered in the Phase 1 UI.**       |
| `errorMessage`  | `String` (nullable) | Validator (on `PENDING→FAILED`) or Scraper (on `RUNNING→FAILED`) | One of the closed error strings in §2.2. Set only on `FAILED`; ownership partitioned by guarded transition (§2.1). |
| `createdAt`     | `AWSDateTime`      | Amplify-managed                                             | Set automatically by AppSync on creation.                                                              |
| `updatedAt`     | `AWSDateTime`      | Amplify-managed                                             | Updated automatically by AppSync on every mutation.                                                    |
| `expiresAt`     | `Int` (epoch)      | Validator                                                   | DynamoDB TTL attribute. Set to ~30 days from creation. Reclaims rows, including orphaned `PENDING` rows if the Scraper never ran. |

### 2.1 Write ownership and conditional transitions (normative)

Write ownership is partitioned by **guarded transition**, not globally. Each writer sends only the fields it owns for that transition — it never includes fields belonging to another writer, and never does a read-modify-write of a foreign field.

**All status transitions are conditional on the prior status.** A guard miss is a no-op, never an overwrite.

| Transition            | Writer    | Guard condition       | Fields written in this mutation                                                                           |
|-----------------------|-----------|-----------------------|-----------------------------------------------------------------------------------------------------------|
| `PENDING → RUNNING`   | Scraper   | `status == PENDING`   | `status`                                                                                                  |
| `PENDING → FAILED`    | Validator | `status == PENDING`   | `status`, `errorMessage` (`"Couldn't start the scrape. Try again."`)                                      |
| `RUNNING → SUCCEEDED` | Scraper   | `status == RUNNING`   | `status`, `totalReviews`, `pctPositive`, `scrapedReviews`, `s3Key`                                        |
| `RUNNING → FAILED`    | Scraper   | `status == RUNNING`   | `status`, `errorMessage` (one of the §2.2 strings)                                                        |

The two `PENDING→*` transitions race only if the Validator believes its async invoke failed but AWS actually accepted it and the Scraper already advanced the row to `RUNNING`. Whichever conditional write commits first wins; the loser no-ops — the row never reaches an inconsistent state.

### 2.2 Closed error string set

`errorMessage` carries exactly one of these strings when `status == FAILED`:

| `errorMessage`                                  | Set by    | Condition                                                          |
|-------------------------------------------------|-----------|--------------------------------------------------------------------|
| `"Couldn't start the scrape. Try again."`       | Validator | Lambda async-invoke of the Scraper failed (`PENDING→FAILED`).      |
| `"Couldn't reach Steam. Try again."`            | Scraper   | Network or HTTP failure contacting the Steam API (`RUNNING→FAILED`).|
| `"Couldn't read Steam reviews. Try again."`     | Scraper   | `appreviews` returned `success: false` mid-scrape (`RUNNING→FAILED`).|
| `"Scrape failed. Try again."`                   | Scraper   | S3 write failure or any other unexpected error (`RUNNING→FAILED`). |

### 2.3 Status lifecycle

```
(no row)
    │
    ▼  Validator: POST succeeds, createJob
  PENDING
    │
    ▼  Scraper: PENDING→RUNNING guard commits
  RUNNING
    │
    ├──▶ SUCCEEDED  (S3 written; totalReviews/pctPositive/scrapedReviews/s3Key set)
    └──▶ FAILED     (errorMessage set to one of the §2.2 strings)
```

A zero-review game reaches `SUCCEEDED` with `totalReviews: 0` and `pctPositive: null`. This is valid; the nominal UI renders "0 reviews / N/A".

---

## 3. ScrapeSucceeded EventBridge event

Emitted by the Scraper Lambda after a successful S3 write and `RUNNING→SUCCEEDED` transition, on the custom `reviewlensai` bus.

**This emit is non-fatal.** A `PutEvents` failure is logged but does not affect the `SUCCEEDED` Job row. Phase 2 must handle delayed or missing events gracefully (e.g. by polling the Job row as a fallback).

### Event envelope

| Field        | Value                     |
|--------------|---------------------------|
| `Source`     | `"reviewlensai.scraper"`  |
| `DetailType` | `"ScrapeSucceeded"`       |
| `EventBusName` | `"reviewlensai"`        |

### Detail payload

```json
{
  "jobId": "<uuid>",
  "appId": "<numeric string>",
  "s3Key": "jobs/{jobId}/{appId}.json"
}
```

| Field    | Type     | Description                                           |
|----------|----------|-------------------------------------------------------|
| `jobId`  | `string` | Matches the `Job.id` that reached `SUCCEEDED`.        |
| `appId`  | `string` | The numeric Steam application ID.                     |
| `s3Key`  | `string` | S3 object key for the scraped data payload.           |

The bus name is also written to SSM at `/reviewlensai/scraper/eventBusName` at CDK deploy time for Phase 2 EventBridge rule binding.

---

## 4. S3 object schema (`s3Key`)

Written to `jobs/{jobId}/{appId}.json` in the Scraper's private S3 bucket. **Not readable by the FE in Phase 1.** Phase 2 analytics is the first reader (IAM read grant is a Phase 2 concern).

```json
{
  "game": {
    "name": "string",
    "shortDescription": "string|null",
    "aboutTheGame": "string|null",
    "genres": "array|null",
    "categories": "array|null",
    "price": "string|null",
    "headerImage": "string|null",
    "releaseDate": "object|null"
  },
  "summary": {
    "totalReviews": "int",
    "totalPositive": "int",
    "pctPositive": "float|null"
  },
  "reviews": [
    {
      "recommendationid": "string",
      "language": "string",
      "review": "string",
      "timestamp_created": "int",
      "timestamp_updated": "int",
      "voted_up": "bool",
      "votes_up": "int",
      "votes_funny": "int",
      "steam_purchase": "bool",
      "received_for_free": "bool",
      "written_during_early_access": "bool",
      "author": {
        "playtime_at_review": "int",
        "playtime_forever": "int"
      }
    }
  ]
}
```

`reviews` contains at most 10,000 unique entries (deduped by `recommendationid`). `summary.pctPositive` is `null` when `totalReviews == 0`.

---

## 5. SSM parameters (cross-domain contract)

| Parameter                              | Producer | Consumer    | Value                                     |
|----------------------------------------|----------|-------------|-------------------------------------------|
| `/reviewlensai/appsync/url`            | App      | Scraper CDK | AppSync GraphQL endpoint URL              |
| `/reviewlensai/appsync/apiKey`         | App      | Scraper CDK | API key for `x-api-key` backend writes    |
| `/reviewlensai/amplify/url`            | App      | Scraper CDK | Amplify hosting URL (CORS origin + PM agent base URL) |
| `/reviewlensai/scraper/validatorUrl`   | Scraper  | App CI      | Function URL; written to `VITE_VALIDATOR_URL` |
| `/reviewlensai/scraper/eventBusName`   | Scraper  | Phase 2     | Name of the `reviewlensai` custom EventBridge bus |

**Deploy order is a hard build dependency.** The Scraper CDK reads `appsync/*` and `amplify/url` at synth time. Order: (1) deploy App → (2) deploy Scraper → (3) write `VITE_VALIDATOR_URL` to the Amplify branch env and trigger a rebuild.
