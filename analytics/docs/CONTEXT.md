# Analytics — Context

## Purpose

Turn raw scraped reviews into surface-level analytics the frontend can display,
using classical ML techniques (NLTK; no LLMs in this domain).

## Domain Boundary

- **Trigger:** the scraper's custom `ScrapeSucceeded` EventBridge event on the
  `reviewlensai` bus (bus name read at synth from SSM
  `/reviewlensai/scraper/eventBusName`). The event `detail` carries `jobId` and
  `s3Key`.
- **Compute:** a single EventBridge-triggered Python Lambda. It reads the raw
  scrape JSON from S3, computes the analytics payload, and writes terminal status
  back onto the `Job` row.
- **Output:** analytics are written **back onto the same `Job` row** via an
  AppSync `updateJob` mutation — `analyticsStatus` (`RUNNING` → `SUCCEEDED` /
  `FAILED`), `analyticsJson` (the JSON-stringified payload), and
  `analyticsErrorMessage` on failure. There is no separate analytics table.
- **Downstream:**
  - `app/` subscribes to the `Job` row (Amplify `observeQuery`) and renders the
    parsed `analyticsJson` payload live.
  - `chat/` consumes analytics output via its own EventBridge-triggered ingester.

## Tech Stack

- AWS Lambda (Python 3.12) — the single analytics worker, EventBridge-triggered
- Classical ML via NLTK (pinned `==3.9.1`):
  - VADER (`vader_lexicon`) for compound sentiment
  - averaged-perceptron POS tagging (`averaged_perceptron_tagger_eng`) for
    adjective extraction
  - `BigramCollocationFinder` + PMI for phrase extraction
  - `punkt_tab` tokenizer and `stopwords` corpus
  - NLTK data is bundled into the Lambda ZIP asset (`NLTK_DATA=/var/task/nltk_data`)
- AWS EventBridge (scraper `ScrapeSucceeded` → worker)
- AWS S3 (scrape-data input, bucket owned by `scraper/`)
- AWS SQS (dead-letter queue for failed/throttled invocations)
- AWS AppSync (output sink — `getJob` query + `updateJob` mutation)
- AWS CDK (TypeScript, IaC)
