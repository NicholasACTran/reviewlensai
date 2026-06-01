# S1 Spike — Bedrock Knowledge Base vector backing (S3 Vectors vs Aurora pgvector)

**Date:** 2026-06-01
**Branch:** `phase3/chat-foundations`
**Author:** Spike for the chat domain (Task 1 of the implementation plan)
**Region under test:** us-east-1
**Account:** 934939427723 (per repo memory)

## Intro

The chat domain needs a vector store behind a **Bedrock Knowledge Base (KB)** for RAG over
scraped Steam review corpora. Each scrape **job** produces on the order of ~10,000 review
chunks/vectors, and we expect many jobs to coexist. Retrieval for a chat session must be
**isolated to a single job** via a `jobId` metadata filter (hard requirement).

This spike decides the vector-store backing:
- **Primary:** Amazon S3 Vectors (serverless, no provisioning, pay-per-use).
- **Documented fallback:** Aurora Serverless v2 + pgvector.

Investigation prioritized authoritative web evidence over model memory (knowledge cutoff Jan 2026).
AWS CLI checks against the live account were attempted but the locally installed CLI is too old
to exercise the relevant services (see "Tooling note" below); this does **not** affect the decision,
which rests on AWS documentation and launch announcements.

### Tooling note (CLI could not validate the new services)

The default AWS profile authenticates successfully:

```
$ aws sts get-caller-identity
{
    "UserId": "934939427723",
    "Account": "934939427723",
    "Arn": "arn:aws:iam::934939427723:root"
}
```

However the installed CLI is **aws-cli/2.3.5 (Python/3.8.8, Windows)** — a 2021 build that predates
all three target services. As a result these commands could not run:

```
$ aws s3vectors help
aws: error: argument command: Invalid choice ...   # no `s3vectors` command in this CLI build

$ aws bedrock-agent create-knowledge-base help
aws: error: argument command: Invalid choice ...   # no `bedrock-agent` command

$ aws bedrock list-foundation-models --region us-east-1 ...
aws: error: argument command: Invalid choice ...   # no `bedrock` command
```

This is a **local tooling gap, not a service/account gap** — `s3vectors`, `bedrock`, and
`bedrock-agent` are all genuine, current AWS CLI commands; this old binary simply doesn't ship them.
The CLI must be upgraded (to a 2.31+/recent v2) before any IaC or CLI-based KB creation work.
The decision below is therefore documentation-backed, not CLI-validated.

> **Side note (credentials hygiene):** the caller identity is the account **root** user. Per the
> repo's deploy memory, real work should go through the AWS CLI default profile / an IAM role, not
> root. Flagging for the user — not a blocker for this spike.

## Findings

### (a) Is S3 Vectors GA and usable as a Bedrock KB vector store in us-east-1?

**Result: YES — confirmed.**

- Amazon S3 Vectors reached **General Availability in December 2025** (announced at re:Invent 2025),
  expanding from 5 preview regions to **14 GA regions** that explicitly include **US East (N. Virginia) = us-east-1**.
  - Evidence: AWS What's New, "Amazon S3 Vectors is now generally available with 40 times the scale of preview" (Dec 2025).
    https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/
  - Evidence: AWS News Blog, "Amazon S3 Vectors now generally available with increased scale and performance."
    https://aws.amazon.com/blogs/aws/amazon-s3-vectors-now-generally-available-with-increased-scale-and-performance/
- S3 Vectors is a **first-class, selectable vector store for Bedrock Knowledge Bases.** In the Bedrock
  console you choose "S3 vector bucket" as the vector store, with either **Quick create** (Bedrock
  provisions the vector bucket + index for you) or **choose an existing** vector index.
  - Evidence (AWS docs, "Using S3 Vectors with Amazon Bedrock Knowledge Bases"):
    > "When creating a knowledge base in Amazon Bedrock, you can select S3 Vectors as your vector store."
    > "Quick create a new vector store - Amazon Bedrock creates an S3 vector bucket and vector index and configures them with the required settings for you."
    https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html

### (b) Does it support metadata filtering on Retrieve (to isolate per-job results by `jobId`)?

**Result: YES — confirmed.** A `jobId` custom-metadata filter on the `Retrieve` API is supported.

- Bedrock KB supports metadata filtering on `Retrieve` / `RetrieveAndGenerate` via
  `retrievalConfiguration.vectorSearchConfiguration.filter`. This is a general KB feature and applies
  to the S3 Vectors backing.
  - Evidence: AWS ML blog, "Amazon Bedrock Knowledge Bases now supports metadata filtering to improve retrieval accuracy."
    https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-knowledge-bases-now-supports-metadata-filtering-to-improve-retrieval-accuracy/
  - Evidence: AWS ML blog, "Building cost-effective RAG applications with Amazon Bedrock Knowledge Bases and Amazon S3 Vectors" (covers S3 Vectors + metadata filtering end to end).
    https://aws.amazon.com/blogs/machine-learning/building-cost-effective-rag-applications-with-amazon-bedrock-knowledge-bases-and-amazon-s3-vectors/
- For S3 Vectors specifically, custom metadata is **filterable by default** and attached per vector. The
  S3 Vectors + Bedrock KB integration permits **up to 1 KB of custom metadata and up to 35 metadata keys per vector**.
  - Evidence (AWS docs, S3 Vectors + Bedrock KB "Limitations"):
    > "When using S3 Vectors as your vector store with Amazon Bedrock Knowledge Bases, you can attach up to 1KB of custom metadata and 35 metadata keys per vector."
    https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html
- A single short `jobId` string fits comfortably within the **2 KB filterable-metadata** per-vector limit
  (raw S3 Vectors limit; the KB integration is the tighter 1 KB / 35-key envelope above).
  - Evidence (AWS docs, S3 Vectors "Limitations and restrictions"): "Filterable metadata per vector: Up to 2 KB."
    https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-limitations.html

**Caveat to design around:** S3 Vectors KB integration reserves part of the metadata budget for
parent-child / hierarchical-chunking context stored as **non-filterable** metadata, and supports only
**up to 10 non-filterable metadata keys per index**. With ordinary (non-hierarchical) or fixed-size
chunking, a small `jobId` filterable key is well within budget. Avoid very high-token hierarchical
chunking, which AWS warns can blow the metadata size limit.

### (c) Scale/limit caveats near ~10,000 vectors per job, many jobs in one shared index?

**Result: No capacity problem. The shared-index design fits with huge headroom; the real caveats are
ingestion throughput and the metadata budget, not vector count.**

Published S3 Vectors limits (AWS docs, "Limitations and restrictions"):
https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-limitations.html

| Limit | Value | Relevance to us |
| --- | --- | --- |
| Vectors per vector index | Up to **2,000,000,000** | ~10k/job × many jobs is negligible (2B / 10k = 200,000 jobs/index) |
| Vector indexes per vector bucket | 10,000 | Allows per-job indexes too, if we ever prefer isolation-by-index |
| Vector buckets per Region per account | 10,000 | Ample |
| Dimensions per vector | 1–4,096 | Titan v2 (1,024) and Titan v1 (1,536) both fit |
| Total metadata per vector | Up to 40 KB | Fine |
| Filterable metadata per vector | Up to 2 KB | `jobId` fits easily |
| Non-filterable metadata keys per index | Up to 10 | Watch with hierarchical chunking |
| PutVectors + DeleteVectors req/s per index | Up to 1,000 | **Ingestion throughput ceiling** |
| Vectors inserted+deleted/s per index | Up to **2,500** | **~10k vectors ≈ 4s minimum per job at the cap; concurrent job ingests share this** |
| Top-K per QueryVectors | Up to 100 | Fine for RAG retrieval |

Evidence on scale jump and latency:
- "you can store and query up to two billion vectors per index and elastically scale to 10,000 vector
  indexes per vector bucket" (40× the preview's 50M/index cap).
  https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/
- Latency for KB retrieval: "Sub-second cold query latency and as low as 100 millisecond warm query latency."
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html

**Net:** A single shared index keyed by a `jobId` filterable metadata field is well within limits.
The only operationally meaningful caveats are (1) **per-index write throughput** (≤2,500 vectors/s, so
many simultaneous job ingestions serialize against a shared index — acceptable for a PoC, revisit if we
parallelize many large scrapes), and (2) **semantic-search only** (no hybrid/keyword search) plus
**floating-point vectors only**. If write contention ever bites, the 10,000-indexes-per-bucket headroom
lets us switch to **one index per job** with no schema change.

### Embedding model availability (Titan v2)

Could not confirm via CLI (old binary, see Tooling note). Per AWS docs, S3 Vectors KB supports the
standard Bedrock embedding models, and dimension limits (1–4,096) accommodate **Titan Text Embeddings V2**
(1,024 dims). **Model access for Titan embeddings must be enabled in the Bedrock console** for the account
before a KB sync will succeed — flagged below for the user. (Repo memory `reference_bedrock_anthropic_access`
notes the account use-case form / model-access approval gotchas for the Bedrock chat models; the same
console model-access step applies to the embedding model.)

## DECISION

`KB backing = S3 Vectors`

Both gating conditions are met by authoritative AWS evidence: S3 Vectors is **GA in us-east-1** and is a
**selectable Bedrock KB vector store**, and **metadata filtering on `Retrieve` with a custom `jobId` field
is supported**. Scale is a non-issue (2B vectors/index vs ~10k/job). This avoids the Aurora Serverless v2
fallback's ~5–10 min provisioning latency and standing run cost.

> Fallback (not chosen): `KB backing = Aurora Serverless v2 + pgvector`. Reinstates ~5–10 min cluster
> provisioning/cold-start and ongoing run cost that S3 Vectors avoids, and pulls in the Bedrock-access
> setup gotchas from repo memory (`reference_bedrock_anthropic_access`). Keep documented only as a
> contingency if S3 Vectors hits an unforeseen blocker (e.g., the hybrid-search / non-filterable-metadata
> constraints prove limiting).

## Open for the user (Console / account actions)

1. **Enable Bedrock model access for the embedding model** (e.g., Amazon Titan Text Embeddings V2) in the
   Bedrock console for account 934939427723 / us-east-1. A KB sync fails without it. (Could not verify via
   CLI — old binary.)
2. **Upgrade the local AWS CLI.** The installed `aws-cli/2.3.5` (2021) lacks the `s3vectors`, `bedrock`,
   and `bedrock-agent` commands, so no CLI/IaC validation of the KB was possible. Upgrade to a current
   v2 before implementation.
3. **Stop using account root for deploys.** Caller identity resolved to the root user; per repo deploy
   memory, switch to the IAM default profile / role.
4. **Confirm chunking strategy** before ingestion. Avoid very-high-token hierarchical chunking with
   S3 Vectors (risks exceeding the metadata size limit, since hierarchical context is stored as
   non-filterable metadata, capped at 10 keys / part of the 40 KB-per-vector budget). Fixed-size or
   default chunking + a small `jobId` filterable key is the safe path.

## Sources

- AWS What's New — Amazon S3 Vectors GA (Dec 2025): https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-vectors-generally-available/
- AWS News Blog — S3 Vectors GA: https://aws.amazon.com/blogs/aws/amazon-s3-vectors-now-generally-available-with-increased-scale-and-performance/
- AWS Docs — Using S3 Vectors with Amazon Bedrock Knowledge Bases: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html
- AWS Docs — S3 Vectors Limitations and restrictions: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-limitations.html
- AWS ML Blog — Bedrock KB metadata filtering: https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-knowledge-bases-now-supports-metadata-filtering-to-improve-retrieval-accuracy/
- AWS ML Blog — Cost-effective RAG with Bedrock KB + S3 Vectors: https://aws.amazon.com/blogs/machine-learning/building-cost-effective-rag-applications-with-amazon-bedrock-knowledge-bases-and-amazon-s3-vectors/
