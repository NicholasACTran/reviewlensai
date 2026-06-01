# Review Lens AI Design and Architecture

## System Architecture

### Overview

Review Lens AI is a monorepo project deployed via GitHub actions onto AWS infrastructure. The frontend of the app is a React app deployed onto AWS Amplify. Each of the various functionalities (scraper, analytics, chat) will be separate backend domains that the app will interact with.

### Scraper

The scraper service runs as two Python Lambdas — a synchronous **Validator**
(public Function URL) and an asynchronous **Scraper** — that scrape Steam game
review data and put it onto AWS S3 (capped at 10k reviews/game). The frontend
triggers the Validator, then tracks the job in real time via the shared `Job`
row (DynamoDB/AppSync). (The original Batch/Fargate/ECR design was replaced with
Lambda in Phase 1 for simplicity.) See `scraper/docs/CONTEXT.md` for more details.

### Analytics

Triggered by the scraper's custom `ScrapeSucceeded` EventBridge event (on the `reviewlensai` bus), a single Python 3.12 Lambda reads the scraped reviews from S3 and computes summarized analytics using classical NLTK techniques (VADER weekly sentiment, perceptron POS + PMI word/phrase associations, top helpful reviews). It writes the result back onto the same `Job` row via an AppSync `updateJob` mutation — `analyticsStatus` plus a JSON-stringified `analyticsJson` payload — for the frontend to subscribe to and display. Failed or throttled invocations route to an SQS dead-letter queue. (The original AnalyticsSubmitter + Batch/Fargate/ECR design was replaced with this single Lambda in Phase 2 for simplicity.) See `analytics/docs/CONTEXT.md` for more details.

### Chat

The AI Chat bot is hosted via AWS Bedrock Agent (Amazon Nova Pro,
us-east-1) with a Bedrock Knowledge Base backed by Aurora Serverless v2 +
pgvector. Two Node 20 Lambdas: `ChatIngester` (EventBridge-triggered on
analytics SUCCEEDED, uploads docs + sidecar metadata, kicks off
`StartIngestionJob`) and `ChatTurn` (FE-facing Function URL, sanitizes input,
invokes the agent via the `invokeAgentForJob` wrapper with a server-derived
`jobId` metadata filter, streams chunks back via AppSync `ChatMessage`
mutations with a full `selectionSet` so subscriptions deliver complete
rows). Bedrock Guardrails attached at the agent level (denied topics,
content filters at HIGH, PII anonymize, contextual grounding). Lambda
output post-filters layer on top to handle Nova-specific edge cases
(non-English mirror, system-prompt sentinel detection, Steam-platform
synonym scope drift, PII token stripping). See `chat/docs/CONTEXT.md`
for the per-component build details.

### Deployment

Each domain of the application will use it's own CI/CD via Github actions and AWS CDK. This will create separate CloudFormation stacks and resources. Each domain will interact with each other via a variety of Lambdas and Event Queues that are defined in each repo's `docs/API_CONTRACT.md`.

### Auth

This a PoC app, there will be no auth services.

### Testing

Besides unit and integration testing. Scraper and analytics functionality
can be tested E2E via AWS CLI. Chat is red-teamed locally via a Playwright
+ API-direct adversarial-PM subagent (`.claude/agents/adversarial-pm.md`)
against a corpus that'll be set and grown through exploratory testing.

## Project Phases

Some of the work of this project can be done in parallel, while some of the work require sequential effort. For each phase of work, refer to the relevant docs in each domain's `docs/product/prds/`

### Phase 1: Scraper and basic App functionality

In this first phase, these two domains can be setup in parallel. Here, the full scraper functionality can be setup, while a functional React App can be setup to integrate with the Scraper.

### Phase 2: Analytics and Chat

In this second phase, these two domains can be setup in parallel. The analytics functionality can be developed alongside the chat, with the chat functionality initial knowledge base being from the scraped data. Once the analytics functionality is finished, then the chat bot can integrate the analytics into it's own knowledge base.

### Phase 3: Chat domain end-to-end

Stood up the full chat stack: Bedrock Agent (Amazon Nova Pro via US
cross-region inference profile), Bedrock Knowledge Base (Aurora Serverless
v2 + pgvector backing, Titan v2 1024-dim embeddings, NONE chunking),
Bedrock Guardrails (denied topics, content filters, PII anonymize,
contextual grounding), `ChatIngester` + `ChatTurn` Lambdas, FE ChatDrawer
+ ChatPanel + Citations + chat subscription hook. Schema additions
(`Job.chatStatus`, `Job.chatErrorMessage`, `ChatMessage` model) merged to
main.

### Phase 4: Tuning and additional functionality (future)

Once Phase 3 has hardened in real user testing, additional tuning per
domain can be developed in parallel.