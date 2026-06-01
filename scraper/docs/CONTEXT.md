# Scraper — Context

## Purpose

Scrape Steam user review data for a given game URL and land the
raw data in S3 for downstream analytics and chat.

## Domain Boundary

- **Trigger:** Frontend (`app/`) POSTs a Steam URL to the **Validator Lambda**
  (public Function URL).
- **Compute:** Two Python Lambdas — a fast synchronous **Validator** and an
  asynchronous **Scraper** (no AWS Batch; replaced by Lambda for simplicity —
  see `ARCHITECTURE.md`).
- **Output:** Raw review JSON written to S3 under a job-scoped prefix
  (`jobs/{jobId}/{appId}.json`), capped at `MAX_REVIEWS` (default 10,000).
- **State:** Per-job status lives on the shared `Job` row (DynamoDB via AppSync),
  written by both Lambdas through conditional mutations. The frontend watches it
  in real time via `observeQuery`.
- **Downstream:** On success the Scraper emits a custom EventBridge event
  (`reviewlensai.scraper` / `ScrapeSucceeded`) on the `reviewlensai` bus, which
  Phase 2 analytics will consume (see `analytics/docs/CONTEXT.md`).

See the canonical interface (Validator request/response, `Job` fields,
`ScrapeSucceeded` schema) in `scraper/docs/API_CONTRACT.md`.

## Tech Stack (as built)

- AWS Lambda — Python 3.12 (Validator + async Scraper)
- AWS S3 (storage, 30-day lifecycle on `jobs/*`)
- AWS EventBridge (custom `reviewlensai` bus, `ScrapeSucceeded` event)
- AWS SQS (Scraper async-invoke DLQ) + CloudWatch alarms
- AWS AppSync (canonical `Job` write API, `x-api-key` auth)
- AWS CDK (TypeScript, IaC) — deployed via GitHub Actions
- Steam JSON endpoints: `appdetails` (metadata) + `appreviews` (reviews)
