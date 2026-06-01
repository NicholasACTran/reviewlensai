# Analytics - Architecture

> **As-built note (Phase 1):** the scraper was reimplemented as Lambdas (no AWS
> Batch). The cross-domain trigger below — an `aws.batch` `Batch Job State Change`
> rule keyed on `/reviewlensai/scraper/jobQueueArn` — is **superseded**: the
> scraper now emits a custom `ScrapeSucceeded` event on the `reviewlensai` bus
> (`/reviewlensai/scraper/eventBusName`). The analytics *worker* may still run on
> Batch/Fargate; only the scraper→analytics trigger changed. This doc is Phase 2
> aspirational and will be reconciled when Phase 2 is specced.

## AWS resources (CDK: `analytics/cdk/lib/analytics-stack.ts`)

- **AnalyticsSubmitter Lambda** (Node 20, arm64, 256 MB, 15s timeout). No public URL — invoked exclusively by EventBridge. Reads the `Job` row via AppSync `getJob`, gates idempotency, writes `analyticsStatus: PENDING`, then calls `Batch.SubmitJob`.
- **EventBridge rule** `AnalyticsSubmitterRule` filtered to `aws.batch` `Batch Job State Change` events where `detail.status: SUCCEEDED` AND `detail.jobQueue` matches the scraper's queue ARN (read at synth from SSM `/reviewlensai/scraper/jobQueueArn`). Target: the Submitter Lambda.
- **AWS Batch (Fargate)** compute environment (1 vCPU, 4 GB, `maxvCpus: 4` headroom) + job queue + single `AnalyticsJobDefinition`. 30-minute timeout, 1 retry attempt. Container ENTRYPOINT runs `python -m analytics_worker.main`; Batch passes `--job-id`, `--s3-keys` via Ref parameters (`Ref::jobId`, `Ref::s3Keys`).
- **ECR repository** `reviewlensai-analytics` — imported by the stack (pre-created by the deploy workflow), holds the worker image at tag `latest`.
- **CloudWatch log groups**, 14-day retention, on Submitter Lambda and Batch task (stream prefix `analytics-worker`).
- **IAM roles:**
  - `AnalyticsTaskExecutionRole` — `AmazonECSTaskExecutionRolePolicy` + `ecr:Pull` on the analytics ECR repo.
  - `AnalyticsJobRole` (task role) — explicit `s3:GetObject` on `arn:aws:s3:::<scrapeBucket>/jobs/*` and `appsync:GraphQL` on the `updateJob` field ARN.
  - Submitter execution role — `appsync:GraphQL` on `getJob` and `updateJob` field ARNs + `batch:SubmitJob` on the analytics queue / job-definition ARNs.

## Cross-domain SSM dependencies consumed

All read at synth time via `StringParameter.valueForStringParameter`:

| Parameter                              | Producer  | Used for                                                              |
|----------------------------------------|-----------|-----------------------------------------------------------------------|
| `/reviewlensai/appsync/url`            | `app/`    | AppSync endpoint baked into Submitter Lambda and Batch task env       |
| `/reviewlensai/appsync/apiId`          | `app/`    | Constructs the field-level ARN `/types/.../fields/{getJob,updateJob}` |
| `/reviewlensai/appsync/apiKey`         | `app/`    | API-key auth for `getJob` / `updateJob` calls                         |
| `/reviewlensai/scraper/jobQueueArn`    | `scraper/`| EventBridge `detail.jobQueue` filter (only fire on scraper-queue events) |
| `/reviewlensai/scraper/bucketName`     | `scraper/`| IAM `s3:GetObject` grant + worker runtime `S3_BUCKET` env var         |

Both scraper-side SSM params are produced by `scraper/cdk/lib/scraper-stack.ts` (`ScraperJobQueueArnSsmParam`, `ScraperBucketNameSsmParam`). They must exist before this stack is deployed.

## Runtime behaviors

- **Submitter idempotency.** Submitter exits as a no-op if any of the following hold (logged with a `submitter_skipped_*` event so each skip is observable):
  - `event.detail.parameters.jobId` is missing — emits `submitter_skipped_no_jobid`.
  - `getJob` returns null — emits `submitter_skipped_no_row`.
  - Row `status !== 'SUCCEEDED'` — emits `submitter_skipped_status` (defends against future detail-status changes).
  - Row `analyticsStatus !== null` — emits `submitter_skipped_idempotent`. The EventBridge → Lambda async invoke can deliver duplicates; this gate is the deduplication.
  - `s3Keys` empty or null — emits `submitter_skipped_no_s3keys`. Nothing to analyze.
- **Submitter ordering (Patch #2).** Submitter writes `analyticsStatus: PENDING` via `updateJob` BEFORE calling `Batch.SubmitJob`. Inverting the order can race: the worker can start and write `analyticsStatus: RUNNING` before the PENDING write lands, making the FE subscription regress (`RUNNING` → `PENDING`). The trade-off: a Batch-submit failure leaves a row stuck at `PENDING`; the future `AnalyticsWatchdog` (spec §10, deferred) will rescue these.
- **Worker dispatch.** `main.py` runs `run_game_analytics(s3_keys, reader)` — sentiment series (weekly/monthly/all-time), word associations (adjectives + phrases), top-3 helpful positive/negative reviews. GAME jobs always have exactly one S3 object.
- **Error taxonomy.** Worker writes one of three constrained `analyticsErrorMessage` strings on FAILED — never raw exception text:
  - `"No reviews to analyze."` — `NoReviewsError` (zero S3 docs or game has zero reviews).
  - `"Could not read scrape data."` — `S3ReadError` (S3 GetObject failure, JSON parse failure).
  - `"Analytics worker failed."` — catch-all for any other exception.
- **Retry policy.**
  - AppSync `updateJob` (worker): 1 retry on 5xx / network error with 500ms backoff. 4xx is NOT retried (caller-side input error).
  - AppSync calls (Submitter): same 1-retry-with-500ms policy.
  - S3 `GetObject` (worker): boto3 default retry config (standard mode, 3 attempts).
  - `Batch.SubmitJob` (Submitter): AWS SDK default retry config.
- **§11 fallback (analytics payload as JSON string).** `@aws-amplify/backend@1.4.0` does not support `a.customType()` arrays, so the analytics payload is stored as a single JSON-stringified string on `Job.analyticsJson` instead of a nested custom type. The Python worker calls `json.dumps(payload)` with camelCase keys; the FE parses via `parseAnalytics()` in `app/src/types/analytics.ts`, which returns `AnalyticsPayload | null` (tolerant — returns null on parse error or non-object payload). The hand-rolled TypeScript interface in `app/src/types/analytics.ts` is the single source of truth for the payload shape; the FE renderer, the FakeAmplifyClient fixtures, and the Python worker all conform to it.

## Observability

Structured JSON logs with `jobId` per line (helper: `analytics_worker.log.log_json` / `submitter/index.ts logJson`). Event vocabulary (spec §8):

- **Submitter**
  - `submitter_invoked` (jobId, eventDetail)
  - `submitter_skipped_no_jobid`
  - `submitter_skipped_no_row` (jobId)
  - `submitter_skipped_status` (jobId, status)
  - `submitter_skipped_idempotent` (jobId, analyticsStatus)
  - `submitter_skipped_no_s3keys` (jobId)
  - `submitter_submitted` (jobId, batchJobId)
  - `submitter_submit_failed` (jobId, error)
- **Worker**
  - `worker_start` (jobId, s3Keys count)
  - `sentiment_complete` (weeklyPoints, monthlyPoints, allTimePoints)
  - `words_complete` (adjectives, phrases)
  - `helpful_complete` (positive, negative)
  - `worker_complete` (jobId)
  - `worker_no_reviews` (jobId) — terminal FAILED with `"No reviews to analyze."`
  - `worker_s3_read_failed` (jobId, error) — terminal FAILED with `"Could not read scrape data."`
  - `worker_failed` (jobId, error) — terminal FAILED with `"Analytics worker failed."`
  - `worker_failed_terminal_write_failed` (jobId, error) — the FAILED write itself failed; exit 1
- **AppSync client (worker + submitter)**
  - `appsync_call_start` (attempt, jobId, analyticsStatus)
  - `appsync_call_complete` (jobId)
  - `appsync_call_retrying` (jobId)
  - `appsync_call_failed` (attempt, jobId, error)