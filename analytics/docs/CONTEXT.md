# Analytics — Context

## Purpose

Turn raw scraped reviews into surface-level analytics the frontend can display,
using classical ML techniques (no LLMs in this domain).

## Domain Boundary

- **Trigger:** Job-complete event emitted by `scraper/`.
- **Compute:** AWS Batch job reads raw reviews from S3.
- **Output:** Summarized analytics written to a DynamoDB table.
- **Downstream:**
  - `app/` reads summarized analytics via Lambdas in front of DynamoDB.
  - `chat/` consumes analytics output as a Bedrock knowledge base.

## Tech Stack

- AWS Batch on Fargate (job runner) — Python 3.12
- AWS Lambda (Node 20, AnalyticsSubmitter) — EventBridge-triggered
- AWS EventBridge (scraper-SUCCEEDED → Submitter)
- AWS S3 (input, owned by `scraper/`)
- AWS AppSync (output sink — writes back onto the same `Job` row)
- AWS CDK (TypeScript, IaC)
- Classical ML: NLTK VADER (sentiment), spaCy `en_core_web_sm` (word associations)