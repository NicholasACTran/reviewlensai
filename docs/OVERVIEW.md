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

> **Status: planned, not built.** The description is the *intended* shape; the
> enforcement stack is being re-decided (see
> `docs/specs/2026-06-01-phase-3-chat-boundaries-and-corpus-design.md`). No chat
> resources or schema fields exist yet.

The AI chat bot is planned as a per-job assistant grounded only on a single
Job's scraped reviews + analytics, with a closed 4-refusal boundary model
(English-only, grounded-or-refuse, neutral toxic-summary, server-derived job
isolation). Candidate (undecided) infra: a Bedrock-based agent + knowledge base
+ guardrails with `ChatIngester`/`ChatTurn` components. Boundaries and the
red-team corpus are specified and live under `chat/red-team/`.

### Deployment

Each domain of the application will use it's own CI/CD via Github actions and AWS CDK. This will create separate CloudFormation stacks and resources. Each domain will interact with each other via a variety of Lambdas and Event Queues that are defined in each repo's `docs/API_CONTRACT.md`.

### Auth

This a PoC app, there will be no auth services.

### Testing

Besides unit and integration testing. Scraper and analytics functionality
can be tested E2E via AWS CLI. Chat **will be** red-teamed locally via a
Playwright + API-direct adversarial-PM subagent
(`.claude/agents/adversarial-pm.md`) against the corpus under `chat/red-team/`,
once the bot is built.

## Project Phases

Some of the work of this project can be done in parallel, while some of the work require sequential effort. For each phase of work, refer to the relevant docs in each domain's `docs/product/prds/`

### Phase 1: Scraper and basic App functionality

In this first phase, these two domains can be setup in parallel. Here, the full scraper functionality can be setup, while a functional React App can be setup to integrate with the Scraper.

### Phase 2: Analytics and Chat

In this second phase, these two domains can be setup in parallel. The analytics functionality can be developed alongside the chat, with the chat functionality initial knowledge base being from the scraped data. Once the analytics functionality is finished, then the chat bot can integrate the analytics into it's own knowledge base.

### Phase 3: Chat domain end-to-end

**In progress.** Phase 3 (a) specifies the chat bot's boundaries + red-team
corpus (done — `docs/specs/2026-06-01-phase-3-chat-boundaries-and-corpus-design.md`,
`chat/red-team/`), (b) re-decides the enforcement stack in an architecture
brainstorm, then (c) builds the bot (`ChatIngester` + `ChatTurn` + chosen
grounding/guardrails), the schema additions (`Job.chatStatus`,
`Job.chatErrorMessage`), direct Function URL response streaming (no `ChatMessage`
model), and the FE chat UI — **none of which exist yet.**

### Phase 4: Tuning and additional functionality (future)

Once Phase 3 has hardened in real user testing, additional tuning per
domain can be developed in parallel.