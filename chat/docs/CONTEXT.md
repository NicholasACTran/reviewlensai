# Chat — Context

## Purpose

Conversational interface over the reviews and analytics. Lets users ask an AI
assistant about specific trends, complaints, or themes in the scraped review
set for a single Job. Per-job session; refuses everything outside that
Job's retrieved review and analytics chunks.

## Domain Boundary

- **Inference (planned — stack TBD):** a Bedrock-based agent + knowledge base
  + guardrails is the *candidate* shape (not built, not decided). Expected
  logical components: `ChatIngester` + `ChatTurn`.
- **Knowledge:** scraped review JSON files (from `scraper/` S3) + the
  analytics JSON (from `analytics/`).
- **Frontend integration (planned):** `app/` will call the `ChatTurn` Lambda
  Function URL directly (no direct Bedrock calls from the browser). Chat
  messages will flow back to the FE via AppSync subscription on a `ChatMessage`
  model.

## Tech Stack (CANDIDATE — not decided)

> The enforcement stack is **re-opened** for Phase 3 (see
> `docs/specs/2026-06-01-phase-3-chat-boundaries-and-corpus-design.md` §1).
> Phase 1/2 consistently dropped heavy infra; the items below are *candidates*
> carried over from the original aspirational design, **not** decisions. The
> stack is chosen in a separate architecture brainstorm before any build, and
> a `chat/docs/ARCHITECTURE.md` (plus any deploy workflow) is written then.

- **Grounding:** TBD — a vector knowledge base (e.g. Bedrock KB + Aurora
  pgvector) *or* a lighter retrieval approach. To be decided.
- **Model / guardrails:** TBD — Amazon Nova Pro + Bedrock Guardrails are
  candidates, not committed.
- **Compute:** TBD — `ChatIngester` (ingest + English-only filter) and
  `ChatTurn` (FE-facing turn handler) are the expected logical components, but
  their runtime is undecided. No `chat-deploy.yml` workflow exists yet.

## Boundaries & refusal policy (decided)

The bot's safety/scope boundaries and the closed 4-refusal set are specified in
`docs/specs/2026-06-01-phase-3-chat-boundaries-and-corpus-design.md` (§2–§3) and
verified by the corpus under `chat/red-team/`. Key decided points: English-only
conversation; non-English reviews dropped at chat ingestion; per-job fresh
session; grounded-or-`NO_DATA` (never fabricate); neutral toxic-summary (no
verbatim slurs); server-derived `jobId` isolation.