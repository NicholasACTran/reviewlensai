# Chat — Context

## Purpose

Conversational interface over the reviews and analytics. Lets users ask an AI
assistant about specific trends, complaints, or themes in the scraped review
set for a single Job. Per-job session; refuses everything outside that
Job's retrieved review and analytics chunks.

## Domain Boundary

- **Inference:** AWS Bedrock Agent + Bedrock Knowledge Base + Bedrock
  Guardrails. Two Lambdas (`ChatIngester`, `ChatTurn`).
- **Knowledge:** scraped review JSON files (from `scraper/` S3) + the
  analytics JSON (from `analytics/`).
- **Frontend integration:** `app/` calls the `ChatTurn` Lambda Function URL
  directly (no direct Bedrock calls from the browser). Chat messages flow
  back to the FE via AppSync subscription on a `ChatMessage` model.

## Tech Stack

- **Bedrock Agent** — `reviewlensai-chat-agent` in `us-east-1`.
  - **Foundation model:** Amazon Nova Pro via US cross-region inference
    profile (`us.amazon.nova-pro-v1:0`). Chosen over Anthropic Claude 3.5/4.5
    Haiku because of an unresolved AWS Marketplace `INVALID_PAYMENT_INSTRUMENT`
    block on Anthropic models on this account; Nova is AWS-native and skips
    the Marketplace flow. (Spec v6 originally chose Claude 3.5 Haiku.)
  - **Knowledge base:** Aurora Serverless v2 + pgvector via the L2
    `@cdklabs/generative-ai-cdk-constructs` `amazonaurora.AmazonAuroraVectorStore`
    + `bedrock.VectorKnowledgeBase`. Embeddings: Titan v2 1024-dim. Chunking
    strategy: `NONE` (preserves the `[job=<jobId>]` text prefix on each chunk).
  - **Guardrails:** `bedrock.Guardrail` with denied topics
    (`off_scope_topics`, `system_prompt_extraction`, `external_link_engagement`,
    `non_english_communication`), content filters at HIGH on all categories
    (PROMPT_ATTACK HIGH-input / NONE-output), PII anonymization for
    `General.{EMAIL,PHONE,NAME,ADDRESS,AGE}` + `Finance.CREDIT_DEBIT_CARD_NUMBER`,
    contextual grounding + relevance at 0.75.
- **Lambdas (Node 20):**
  - **`ChatIngester`** — triggered on analytics Batch SUCCEEDED via
    EventBridge OR via Function URL retry. Pre-flights the Job row, uploads
    KB documents + sidecar metadata, calls `StartIngestionJob`, polls
    `GetIngestionJob` to completion, writes `chatStatus` transitions.
  - **`ChatTurn`** — Function URL POST handler. Sanitizes input, reads Job
    row, creates USER + ASSISTANT ChatMessage rows, calls
    `invokeAgentForJob` (the only sanctioned `bedrock-agent:InvokeAgent`
    site — enforced via `eslint no-restricted-imports`), streams chunks
    back via batched AppSync `update` mutations with full `selectionSet`.
    Reserved concurrency: 10. Wall timeout: 80s (in-loop `Date.now()` check).
- **Post-filters (output-side, in `ChatTurn`):** mirror what AWS doesn't
  reliably enforce alone. See `chat/docs/engineering/CONTEXT.md` for the
  complete list. Briefly: rewrites any of the following in the response
  body to the canned refusal `"I can only discuss the review data for this
  analysis."`:
  - Bedrock Guardrails leak strings ("blocked by content filters")
  - >20% non-ASCII output (Nova mirrors user language; we force English)
  - System-prompt sentinel phrases (chunked exfiltration detection)
  - Steam-platform scope drift terms (refunds/refund policy, storefront or
    purchasing questions, account/billing, game keys, Steam Support, etc.
    — broadened across red-team rounds to handle synonyms and hyphenated
    variants)
  - Also strips PII anonymization tokens (`{EMAIL}` etc.) to `[redacted]`
- **Input pre-filter (input-side):** rejects user prompts with >20%
  non-ASCII before any Bedrock call (deterministic English-only enforcement).
- **CDK:** `chat/cdk/` package, deployed via `.github/workflows/chat-deploy.yml`
  (workflow_dispatch only — Aurora provisioning takes ~5-10 min and is
  costly to retry on local Docker, see `MEMORY.md` reference for the local
  build gotchas).