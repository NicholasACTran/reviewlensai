# Scraper — Context

## Purpose

Scrape Steam user review data for a given game URL and land the
raw data in S3 for downstream analytics and chat.

## Domain Boundary

- **Trigger:** Frontend (`app/`) initiates a scrape job via a Lambda entrypoint.
- **Compute:** AWS Batch job runs the scraping workload.
- **Output:** Raw review data written to S3 under a job-scoped prefix.
- **Downstream:** On job completion, emits an event that triggers the Analytics
  Batch job (see `analytics/docs/CONTEXT.md`).
- **Frontend integration:** A small set of Lambdas lets the app trigger jobs,
  poll job status, and query the resulting S3 data.

## Tech Stack (planned)

- AWS Batch (job runner)
- AWS S3 (storage)
- AWS Lambda (trigger / status / query)
- AWS CDK (IaC)
- Language: Python