# Scraper - Architecture

## AWS resources (CDK: `scraper/cdk/lib/scraper-stack.ts`)

- **Validator Lambda** with public Function URL (`AuthType: NONE`, CORS allow-list from SSM `/reviewlensai/amplify/url`). Validates URL shape + does a HEAD pre-check against steam.com. 10s timeout.
- **AWS Batch (Fargate)** compute environment (1 vCPU, 2 GB) + job queue + **one job definition**: `WorkerJobDefinition` (GAME, 5min).
- **ECR repository** `reviewlensai-worker` — single image, used by the job definition.
- **S3 bucket** for raw scrape output, `jobs/{jobId}/{app_id}.json`. 30-day lifecycle on `jobs/*`.
- **JobWatchdog Lambda** + EventBridge rule filtered to `aws.batch` `Batch Job State Change` events with `status: FAILED` on our queue. Flips orphaned `RUNNING` `Job` rows to `FAILED` via a conditional AppSync mutation (`condition: { status: { eq: 'RUNNING' } }`).
- **CloudWatch logs**, 14-day retention, on Validator + Batch task + Watchdog.

## Runtime behaviors

- **Validator HEAD pre-check** is best-effort. Only `HTTP 404/410` and DNS/connect failures fail fast as `Game does not exist.`. Anti-bot blocks (403/503), timeouts, and unrecognized errors pass through. Env var `ENABLE_HEAD_PRECHECK=false` disables it without redeploy.
- **AppSync is the canonical write API for every `Job` row.** Validator, Worker, and Watchdog all write via mutations with API key auth. No direct DynamoDB writes.
- **Networking.** Default VPC, public subnets, `assignPublicIp: true` on Fargate. No NAT.
- **Observability.** Structured JSON logs with `jobId` per line. 
