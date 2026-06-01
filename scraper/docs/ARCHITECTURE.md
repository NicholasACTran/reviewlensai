# Scraper - Architecture

> As-built for Phase 1. The original Batch/Fargate/ECR + JobWatchdog design was
> replaced with two Lambdas during brainstorming (simpler, cheaper, no Docker/ECR
> for a ≤10k-review cap). See `docs/specs/2026-06-01-phase-1-design.md`.

## AWS resources (CDK: `scraper/cdk/lib/scraper-stack.ts`)

- **Validator Lambda** (Python 3.12, 256 MB, 10s) with a public Function URL
  (`AuthType: NONE`). Validates URL shape (host `store.steampowered.com`,
  `/app/{digits}`) then confirms the game via a Steam `appdetails` call. On
  success: creates `Job(PENDING)` (seeded with name/header/price), **async-invokes
  the Scraper** (`InvocationType: Event`, passing the fetched `appdetails`
  payload), and returns `{jobId}`. **CORS is owned entirely by the Function URL
  CORS config** (`allowedOrigins` = the Amplify URL from SSM `/reviewlensai/amplify/url`,
  `allowedMethods: [POST]`) — the handler sets no CORS headers (duplicate
  `Access-Control-Allow-Origin` headers break the browser; `OPTIONS` is not a
  valid Function-URL method and the preflight is auto-handled).
- **Scraper Lambda** (Python 3.12, 1024 MB, 600s, **reserved concurrency 3**,
  async **retryAttempts 0**, on-failure → SQS DLQ). Guards `PENDING→RUNNING`,
  paginates `appreviews` (dedup by `recommendationid`, stop on empty/repeated
  cursor or `MAX_REVIEWS=10000`), writes `jobs/{jobId}/{appId}.json` to S3, flips
  `Job→SUCCEEDED`, and emits `ScrapeSucceeded` (non-fatal) to the custom bus.
- **S3 bucket** for raw scrape output, `jobs/{jobId}/{appId}.json`,
  `BlockPublicAccess: ALL`, 30-day lifecycle on `jobs/*`.
- **Custom EventBridge bus** `reviewlensai` (name exported to SSM
  `/reviewlensai/scraper/eventBusName` for Phase 2). The Validator's Function URL
  is exported to SSM `/reviewlensai/scraper/validatorUrl`.
- **SQS DLQ** + two **CloudWatch alarms** (DLQ depth, Scraper `Errors`;
  `treatMissingData: NOT_BREACHING`).
- **CloudWatch logs**, 14-day retention, on both Lambdas.

## Runtime behaviors

- **No AWS Batch, no ECR, no JobWatchdog, no HEAD pre-check.** Game existence is
  the `appdetails` `success` check in the Validator. Soft scrape failures are
  handled by the Scraper's `try/except → Job FAILED`; hard crashes go to the DLQ
  (alarmed); the FE provides a client-side staleness timeout (no server sweep).
- **AppSync is the canonical write API for every `Job` row.** Validator and
  Scraper write via mutations with **API-key auth** (`x-api-key`, key from SSM
  `/reviewlensai/appsync/apiKey`) — no IAM/SigV4. All status transitions are
  conditional (guarded on the prior status); a guard miss is a no-op.
- **Failure taxonomy** (closed `errorMessage` set): "Couldn't reach Steam. Try
  again." / "Couldn't read Steam reviews. Try again." / "Couldn't start the
  scrape. Try again." / "Scrape failed. Try again." Zero-review games are a valid
  `SUCCEEDED` (`pctPositive` null).
- **Throttle behavior:** at reserved-concurrency=3 the async invoke still returns
  202; the throttled event routes to the DLQ and the row stays `PENDING` until the
  FE staleness timeout (not a Validator-observed error).
- **Networking.** Plain Lambda (AWS-managed internet egress; no VPC/NAT).
- **Observability.** Structured JSON logs with `jobId` per line.

## Deployment

`.github/workflows/scraper-deploy.yml` (GitHub Actions, OIDC role): pytest + ruff
→ build a clean Lambda asset (`build/`, vendoring `requests`) → CDK unit tests +
`cdk deploy` (reads app SSM params at synth) → triggers the app frontend rebuild
so `VITE_VALIDATOR_URL` is baked in. App must be deployed first (spec §6 order).
