# Analytics - Architecture

## AWS resources (CDK: `analytics/cdk/lib/analytics-stack.ts`)

- **Analytics Lambda** (`AnalyticsFn`) — Python 3.12, handler
  `reviewlensai_analytics.main.handler`, 600s timeout, `memorySize: 1024`,
  `reservedConcurrentExecutions: 3`. Code asset is the built ZIP at `../build`
  (the package + vendored `nltk`/`requests` + bundled NLTK data). Env:
  `APPSYNC_URL`, `APPSYNC_API_KEY`, `S3_BUCKET`, `NLTK_DATA=/var/task/nltk_data`.
  Invoked exclusively by EventBridge — no public URL.
- **EventBridge rule** `AnalyticsRule` on the imported `reviewlensai` bus (bound
  by name via `EventBus.fromEventBusName`), filtered to
  `source: ["reviewlensai.scraper"]` AND `detailType: ["ScrapeSucceeded"]`.
  Target: the analytics Lambda.
- **SQS dead-letter queue** `AnalyticsDlq` (14-day retention) — the sink for two
  distinct failure layers:
  - `fn.configureAsyncInvoke({ retryAttempts: 0, onFailure: SqsDestination(dlq) })`
    — **execution** failures (the handler raised) go straight to the DLQ, no retry.
  - The EventBridge target sets `retryAttempts: 2` with the same DLQ — bounds
    **delivery** failures (e.g. invoke throttled under `reservedConcurrency: 3`
    when scrapes finish in a burst) instead of the AWS default 24h/185 attempts.
- **CloudWatch alarms** (both `treatMissingData: NOT_BREACHING`,
  `GREATER_THAN_THRESHOLD 0`, 1 evaluation period):
  - `AnalyticsDlqDepthAlarm` on DLQ `ApproximateNumberOfMessagesVisible`.
  - `AnalyticsErrorsAlarm` on the Lambda's `Errors` metric.
- **IAM grant:** S3 read scoped to `jobs/*` on the scrape bucket
  (`Bucket.fromBucketName(...).grantRead(fn, "jobs/*")`). The bucket is imported,
  not owned, by this stack.

No AWS Batch, no Fargate, no ECR, no Submitter Lambda — the analytics worker is a
single Python Lambda.

## Cross-domain SSM dependencies consumed

All read at synth time via `StringParameter.valueForStringParameter` (each is
overridable by a matching CDK `--context` value):

| Parameter                            | Producer   | Used for                                                   |
|--------------------------------------|------------|------------------------------------------------------------|
| `/reviewlensai/appsync/url`          | `app/`     | AppSync endpoint baked into the Lambda env (`APPSYNC_URL`) |
| `/reviewlensai/appsync/apiKey`       | `app/`     | API-key auth for `getJob` / `updateJob` (`APPSYNC_API_KEY`)|
| `/reviewlensai/scraper/eventBusName` | `scraper/` | Imports the `reviewlensai` bus the EventBridge rule attaches to |
| `/reviewlensai/scraper/bucketName`   | `scraper/` | Imports the scrape bucket for the `jobs/*` read grant + `S3_BUCKET` env |

There is no `jobQueueArn` and no `apiId` consumed. The scraper and app SSM params
must exist before this stack is deployed (the deploy workflow reads them at synth).

## Runtime behaviors

### Handler flow & idempotency (`main.py`)

The handler reads `event.detail.jobId` and `event.detail.s3Key`, then:

1. **Pre-gate skips** (logged, return without writing):
   - missing `jobId` → `worker_skipped reason=no_jobid`
   - missing `s3Key` → `worker_skipped reason=no_s3key`
   - `getJob` returns null → `worker_skipped reason=no_row`
   - row `status != "SUCCEEDED"` → `worker_skipped reason=not_succeeded`
   - row `analyticsStatus is not None` → `worker_skipped reason=already_started`
2. **Atomic idempotency gate.** `updateJob` sets `analyticsStatus: RUNNING`
   guarded by the DynamoDB condition `attribute_not_exists(analyticsStatus)`
   (`attributeExists: false`). A duplicate EventBridge delivery that loses this
   conditional check is a no-op skip → `worker_skipped reason=lost_guard_race`.
   On success → `worker_running`.
3. **Compute.** Read the scrape doc from S3, then `build_payload(doc)`.
4. **Terminal write** (guarded on `analyticsStatus: { eq: "RUNNING" }`):
   - compute OK → `SUCCEEDED` with `analyticsJson = json.dumps(payload)`.
   - `S3ReadError` → `FAILED`, message `"Couldn't read scrape data."`
   - any other exception → `FAILED`, message `"Analytics failed."`

The `SUCCEEDED` write lives outside the compute `try/except` so a write failure is
never re-caught and flipped to `FAILED`. If a terminal write raises **or** misses
its `RUNNING` guard, `_write_terminal` emits
`worker_failed_terminal_write_failed` and **re-raises** — the handler exits
non-zero, EventBridge/async-invoke sends it to the DLQ.

### AppSync write & the full-row selectionSet rule (`appsync.py`)

The `updateJob` mutation returns the **full `Job` row** (`_FULL_JOB_FIELDS` —
`id status steamUrl appId gameName headerImage price totalReviews scrapedReviews
s3Key errorMessage createdAt updatedAt expiresAt analyticsStatus
analyticsErrorMessage analyticsJson`). This is **load-bearing**: AppSync managed
subscriptions deliver only the fields the triggering mutation selected, and the
app's `observeQuery` subscribes with the full model. A minimal selection set made
the FE receive a partial row and crash Amplify's merge (`null.id`), so the
dashboard never appeared. Backend writes must return the full row. (The worker
only *writes* `analytics*` fields; the rest round-trip through the response.)
`getJob` is a direct query, not delivered over a subscription, so it selects only
`id status analyticsStatus` — the fields the handler reads to gate.

### Error taxonomy

Constrained `analyticsErrorMessage` strings written on `FAILED` (never raw
exception text):

| Trigger                          | Message                        | Event                    |
|----------------------------------|--------------------------------|--------------------------|
| `S3ReadError` (GetObject / JSON) | `"Couldn't read scrape data."` | `worker_s3_read_failed`  |
| any other exception in compute   | `"Analytics failed."`          | `worker_failed`          |

`S3ReadError` is the only custom error type (`errors.py`). There is **no**
`NoReviewsError` — an empty scrape is a successful `SUCCEEDED` write with
`hasData: false`, not a failure.

### Retry policy

- AppSync calls (`_post`): 1 retry on HTTP 5xx / network error with 500ms backoff
  (2 attempts total). A `ConditionalCheckFailed` GraphQL error on `updateJob` is
  **not** an error — it's treated as a no-op (`appsync_condition_noop`, returns
  `False` so the caller can detect the lost guard race).
- S3 `GetObject`: boto3 default retry config.

### Payload (`payload.py`) & JSON-string fallback

`build_payload(doc)` produces a flat camelCase dict:

- `hasData` — `len(reviews) > 0`
- `coversFullHistory` — `len(reviews) >= summary.totalReviews`
- `totalAnalyzed` — review count
- `englishReviewCount` — count of `language == "english"` reviews
- `sentiment` — `{ weekly: [...], analyzedAvgCompound }` (weekly buckets keyed by
  ISO week-year in UTC; VADER compound, English subset only)
- `words` — six lists: `{overall,praise,complaint} × {Adjectives,Phrases}`
- `helpful` — `{ positive: [...], negative: [...] }`, top reviews by `votes_up`
  (language-agnostic)

NLP sections require **≥20 English reviews** (`MIN_ENGLISH = 20`); below that the
sentiment/words sections are emitted empty (helpful is always computed).

NLP techniques (`sentiment.py`, `words.py`, `helpful.py`):

- **Sentiment** — VADER `polarity_scores(...)["compound"]`, bucketed by ISO week
  (`datetime.fromtimestamp(ts, tz=utc).isocalendar()`), chronologically sorted;
  also a single mean `analyzedAvgCompound`.
- **Words** — perceptron POS tagging keeps adjectives (`JJ/JJR/JJS`); phrases via
  `BigramCollocationFinder` scored by PMI with a `min_freq` floor. Stopwords +
  the game-name tokens are excluded.
- **Helpful** — eligible reviews (`votes_up >= 1`) split by `voted_up`, ranked
  `votes_up` desc, tiebreak `votes_funny` desc then newer; top 3 each side.

**JSON-string fallback.** `@aws-amplify/backend` does not support `a.customType()`
arrays, so the whole payload is stored as one JSON-stringified blob on
`Job.analyticsJson` rather than a nested custom type. The shared canonical fixture
`analytics/tests/fixtures/analytics_payload.example.json` enforces the worker↔FE
contract. The FE parses it via `parseAnalytics` in `app/src/types/analytics.ts`
(tolerant — returns `null` on null / parse-error / non-object / shape-miss, after
validating the nested structure so a partial payload can't crash a renderer).

## Observability

Structured JSON logs, one per line, with `jobId` (helper:
`reviewlensai_analytics.log.log_json`; field keys are camelCased). Event
vocabulary:

- `worker_invoked` (jobId)
- `worker_skipped` (reason ∈ {`no_jobid`, `no_s3key`, `no_row`, `not_succeeded`,
  `already_started`, `lost_guard_race`}, jobId)
- `worker_running` (jobId)
- `worker_complete` (jobId, hasData, english) — compute produced data
- `worker_empty` (jobId, hasData, english) — `SUCCEEDED` write with `hasData: false`
- `worker_s3_read_failed` (jobId, error) — terminal `FAILED`, `"Couldn't read scrape data."`
- `worker_failed` (jobId, error) — terminal `FAILED`, `"Analytics failed."`
- `worker_failed_terminal_write_failed` (jobId, status, reason/error) — the
  terminal write itself raised or missed its `RUNNING` guard; handler re-raises → DLQ
- `appsync_condition_noop` (jobId, analyticsStatus) — an `updateJob` conditional
  check failed (lost guard race); treated as a no-op, not an error
