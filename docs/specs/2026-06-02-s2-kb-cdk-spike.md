# S2 Spike — CDK construct path for the S3-Vectors KB + Guardrail chat stack

**Date:** 2026-06-02
**Branch:** `phase3/chat-backend-logic`
**Author:** Spike for the chat domain (Task 6 of Plan 2A)
**Region under test:** us-east-1
**Account:** 934939427723 (per repo memory)

## Intro

The enforcement spec (`2026-06-01-phase-3-chat-enforcement-architecture-design.md`, decisions
D1/D4) and spike S1 (`2026-06-01-s1-s3-vectors-spike.md`) settled **what** the chat stack is:

- A **Bedrock Knowledge Base backed by Amazon S3 Vectors** (embeddings: Titan Text Embeddings v2),
  shared index keyed by a `jobId` filterable-metadata field.
- A **Bedrock Guardrail** with a PROMPT_ATTACK input filter + PII anonymization.
- **Node 20 Lambdas** bundling the `chat/src` TypeScript handlers.

This spike resolves **how** to provision all three in AWS CDK (TypeScript, `aws-cdk-lib`) so the
Plan 2B CDK is concrete. Evidence is current web/AWS docs (model knowledge cutoff Jan 2026; S3 Vectors
went GA Dec 2025 and CDK support landed afterward, so live docs were prioritized over memory).

The existing repo CDK convention lives in `scraper/cdk/lib/scraper-stack.ts` and
`analytics/cdk/lib/analytics-stack.ts` (both `aws-cdk-lib` v2 TypeScript apps, Python Lambdas via
`lambda.Function` + asset `Code`). The chat stack is greenfield — there is no `chat/cdk` yet
(`chat/` currently holds only `chat/src` with a jest/ts-jest `package.json`).

---

## Findings

### 1. Does `@cdklabs/generative-ai-cdk-constructs` (the aspirational L2 lib) support an S3 Vectors store? — Effectively NO, because that lib's Bedrock module is DEPRECATED

There are two parts here, and the second one overrides the first:

- **It technically added S3 Vectors support.** The library's KB README shows a `VectorKnowledgeBase`
  taking `vectorStore: s3vectors.VectorIndex`, and its `s3vectors` submodule exposes L2
  `VectorBucket` / `VectorIndex` / `VectorBucketPolicy`. Example from the README:
  ```typescript
  const vectorIndex = new s3vectors.VectorIndex(this, 'VectorIndex', {
    vectorBucket, dimension: model.vectorDimensions!,
    nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
  });
  const kb = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
    embeddingsModel: model, vectorStore: vectorIndex, instruction: '...',
  });
  ```
  Evidence: https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/bedrock/knowledge-bases/README.md
  and https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/s3vectors/README.md

- **But the Bedrock L2 module is officially deprecated and frozen.** The library's Bedrock README
  carries this notice verbatim:
  > "Amazon Bedrock L2 constructs are transitioning to the AWS CDK core repository. You can now find
  > these constructs at: https://github.com/aws/aws-cdk/tree/main/packages/@aws-cdk/aws-bedrock-alpha.
  > Please migrate to the alpha package, as Bedrock L2 constructs in this repository are now deprecated
  > and will no longer receive updates."

  Evidence: https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/bedrock/README.md

- **The successor `@aws-cdk/aws-bedrock-alpha` is experimental (alpha) and S3 Vectors support there is
  unconfirmed.** Its module index exposes `Guardrail`/`ContentFilter`/`PIIFilter` and a `VectorType`
  enum, but I could **not** confirm from authoritative docs that its `VectorKnowledgeBase` accepts an
  S3 Vectors store (the index page doesn't enumerate it; alpha APIs change without notice).
  Evidence: https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_alpha/README.html

**Conclusion for #1:** The L2 path is not the safe choice. The construct that supports S3 Vectors is
deprecated and frozen; its replacement is alpha with unconfirmed S3 Vectors KB support. → Take the **L1**
path, which is fully GA (below).

### 2. L1 path — exact shapes (GA, no third-party lib)

All of this is native `aws-cdk-lib` and GA.

- **S3 Vectors bucket + index** are native L1 in `aws-cdk-lib/aws_s3vectors` (CDK ≥ ~2.257; no
  experimental/preview marking; **no separate `aws-s3vectors` package or custom resource needed**):
  - `s3vectors.CfnVectorBucket` — creates `AWS::S3Vectors::VectorBucket`; exposes
    `attrVectorBucketArn`.
  - `s3vectors.CfnIndex` — creates `AWS::S3Vectors::Index`; required props `dataType` (`'float32'`),
    `dimension` (1–4096), `distanceMetric` (`'cosine' | 'euclidean'`); plus `indexName`,
    `vectorBucketName` **or** `vectorBucketArn`, and optional
    `metadataConfiguration.nonFilterableMetadataKeys`. Exposes `attrIndexArn`.
  - Evidence: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3vectors.CfnIndex.html ,
    https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3vectors.CfnVectorBucket.html

- **Knowledge Base storage config** — `aws-cdk-lib/aws_bedrock.CfnKnowledgeBase`, with
  `storageConfiguration`:
  - `type: 'S3_VECTORS'` — the `Type` property is **Required**, and `S3_VECTORS` is a confirmed allowed
    value. Full enum: `OPENSEARCH_SERVERLESS | PINECONE | RDS | MONGO_DB_ATLAS | NEPTUNE_ANALYTICS |
    S3_VECTORS | OPENSEARCH_MANAGED_CLUSTER`.
  - `s3VectorsConfiguration` (`CfnKnowledgeBase.S3VectorsConfigurationProperty`) with `indexArn` and
    `vectorBucketArn` (alternatively `indexName`). All three sub-props are individually optional in the
    schema; the working pattern supplies `indexArn` + `vectorBucketArn` (wired from the L1 attrs above).
  - Evidence: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-storageconfiguration.html
    (Type enum incl. `S3_VECTORS`) and
    https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-s3vectorsconfiguration.html
    (`IndexArn` / `IndexName` / `VectorBucketArn`)

- **A real CDK tutorial does exactly this with the L1 trio** (`CfnVectorBucket` → `CfnIndex` →
  `CfnKnowledgeBase` + `S3VectorsConfigurationProperty(indexArn, vectorBucketArn)`), and explicitly
  notes it "avoids custom Lambda functions and simplifies IAM policies compared to OpenSearch."
  Evidence: https://deepdive.codiply.com/bedrock-knowledge-base-with-s3-vector-index-in-aws-cdk

**Net for #2:** No custom resource and no preview lib required — `CfnVectorBucket` + `CfnIndex` create
the S3 Vectors store, and `CfnKnowledgeBase.storageConfiguration` references them by ARN. (Contrast:
the older "preview CDK quickstart" approach that predated native L1 needed a custom resource; that is no
longer necessary.)

### 3. Guardrail — use L1 `CfnGuardrail` (`aws-cdk-lib/aws_bedrock`)

Since the L2 Bedrock (generative-ai-cdk-constructs) is deprecated and the alpha replacement is
experimental, the Guardrail goes L1 too — same library, one construct, no extra dependency.

- **PROMPT_ATTACK input filter** lives in `contentPolicyConfig.filtersConfig` with
  `type: 'PROMPT_ATTACK'`, `inputStrength: 'HIGH'`, and `outputStrength: 'NONE'`.
  - **Important caveat:** PROMPT_ATTACK only applies to the input; AWS requires `outputStrength` to be
    `'NONE'` for this filter. A known CDK/CFN friction (aws/aws-cdk#31919) reported confusion around the
    PROMPT_ATTACK strength values; the practical, deploy-safe combination is `inputStrength: 'HIGH'` +
    `outputStrength: 'NONE'`. Validate the synth/deploy of this single filter early in Plan 2B.
  - Evidence: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html ,
    https://github.com/aws/aws-cdk/issues/31919 ,
    https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrock.CfnGuardrail.html

- **PII anonymization** lives in `sensitiveInformationPolicyConfig.piiEntitiesConfig`, a list of
  `{ type: <PII entity>, action: 'ANONYMIZE' }`. For Steam reviewer text, the relevant entity types are
  `EMAIL`, `PHONE`, `NAME`, `USERNAME`, `IP_ADDRESS`, and `URL` (the Bedrock managed PII set also covers
  `ADDRESS`, `AGE`, financial/credit-card and US-specific identifiers — opt into what's relevant; default
  to ANONYMIZE rather than BLOCK so retrieval still returns usable review text). `blockedInputMessaging`
  and `blockedOutputsMessaging` are required top-level props; the chat post-filter normalizes any
  intervention to the canned refusal (enforcement spec D4), so these strings are effectively internal.
  - Evidence: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-guardrail-sensitiveinformationpolicyconfig.html ,
    https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrock-guardrail.html

### 4. Titan v2 embedding model id

- **`amazon.titan-embed-text-v2:0`** — outputs **1024** dimensions by default (also supports 512 / 256).
  The KB's `vectorKnowledgeBaseConfiguration.embeddingModelArn` references this model by ARN
  (`arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0`), and the **S3 Vectors
  `CfnIndex.dimension` MUST equal the embedding dimension (1024)**.
  - Evidence: https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html ,
    https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-titan-text-embeddings-v2-bedrock-knowledge-bases/

### 5. Node 20 Lambda bundling — `aws-lambda-nodejs.NodejsFunction` (esbuild), Docker-free

- **`aws-cdk-lib/aws-lambda-nodejs.NodejsFunction` is the right way** to bundle the `chat/src` TS
  handlers: it uses **esbuild** (transpile + tree-shake + bundle) and, when esbuild is available on the
  host, performs **local bundling without Docker**. Set `runtime: lambda.Runtime.NODEJS_20_X`,
  `entry: <path to chat/src handler>.ts`, `handler: 'handler'`, and (optionally)
  `bundling: { format: OutputFormat.ESM, minify: true, target: 'node20' }`.
- **Why this matters for this repo (memory `feedback_docker_node_path`):** the scraper/analytics stacks
  use **Python** `lambda.Function` with asset bundling that pulls in Docker — and the repo memory records
  that CDK Docker-asset constructs on Windows need `C:\tools\docker-bin` in PATH. **esbuild-based
  `NodejsFunction` sidesteps Docker entirely** as long as `esbuild` is installed as a devDependency of
  the CDK app (otherwise it silently falls back to Docker bundling). So: add `esbuild` to the chat CDK
  app's devDependencies to guarantee the no-Docker path on Windows.
  - Evidence: AWS CDK `aws-lambda-nodejs` docs (NodejsFunction / esbuild local bundling).
- **OneDrive caveat (memory `reference_onedrive_npm_bin`):** local `npm run` bin shims fail under
  OneDrive; invoke `cdk` via `node node_modules/aws-cdk/bin/cdk.js ...` (mirroring the existing
  scraper/analytics CDK invocation pattern). CI on Linux is unaffected.

---

## Minimal CDK code SKETCH (chosen L1 path)

> Illustrative, not exhaustive (IAM role for the KB, data source, and `chat/src` handler wiring are
> Plan 2B). Deliberately **flat L1 + native s3vectors L1** — no vector-store abstraction (spec §13).

```typescript
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

const EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
const EMBED_DIM = 1024;

export class ChatStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1) S3 Vectors store (native L1 — no custom resource)
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'ReviewVectors', {
      vectorBucketName: `reviewlens-vectors-${this.account}`,
    });
    const vectorIndex = new s3vectors.CfnIndex(this, 'ReviewIndex', {
      indexName: 'reviewlens-reviews',
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      dataType: 'float32',
      dimension: EMBED_DIM,                 // MUST match Titan v2 (1024)
      distanceMetric: 'cosine',
      // jobId is a filterable key by default; reserve hierarchical-context keys as non-filterable:
      metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'] },
    });

    // 2) KB execution role (needs bedrock:InvokeModel on Titan + s3vectors access) — abbreviated
    const kbRole = new iam.Role(this, 'KbRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    // kbRole.addToPolicy(... InvokeModel on EMBED_MODEL + s3vectors:* on bucket/index ...);

    // 3) Knowledge Base backed by S3 Vectors
    const kb = new bedrock.CfnKnowledgeBase(this, 'ReviewKb', {
      name: 'reviewlens-review-kb',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn:
            `arn:aws:bedrock:${this.region}::foundation-model/${EMBED_MODEL}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: vectorIndex.attrIndexArn,
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
        },
      },
    });
    kb.addDependency(vectorIndex);

    // 4) Guardrail: PROMPT_ATTACK (input) + PII anonymize
    const guardrail = new bedrock.CfnGuardrail(this, 'ChatGuardrail', {
      name: 'reviewlens-chat-guardrail',
      blockedInputMessaging: 'unable to process',   // post-filter normalizes to canned refusal
      blockedOutputsMessaging: 'unable to process',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'NAME', action: 'ANONYMIZE' },
          { type: 'USERNAME', action: 'ANONYMIZE' },
          { type: 'IP_ADDRESS', action: 'ANONYMIZE' },
          { type: 'URL', action: 'ANONYMIZE' },
        ],
      },
    });

    // 5) Node 20 chat handler — esbuild bundling, NO Docker
    const chatFn = new NodejsFunction(this, 'ChatFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../src/handler.ts',         // chat/src TS handler
      handler: 'handler',
      bundling: { format: OutputFormat.ESM, minify: true, target: 'node20' },
      environment: {
        KB_ID: kb.attrKnowledgeBaseId,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: 'DRAFT',
      },
    });
    // chatFn role: bedrock:Retrieve on kb + bedrock:Converse/ApplyGuardrail — Plan 2B.
  }
}
```

(`esbuild` must be a devDependency of the chat CDK app so `NodejsFunction` bundles locally without
Docker — see Finding 5.)

---

## DECISION

**CDK path = L1.** Provision with native `aws-cdk-lib` L1 constructs: `s3vectors.CfnVectorBucket` +
`s3vectors.CfnIndex` create the S3 Vectors store (dimension 1024, `cosine`, `float32`; no custom
resource and no `@cdklabs/generative-ai-cdk-constructs`), wired by ARN into
`bedrock.CfnKnowledgeBase` `storageConfiguration` (`type: 'S3_VECTORS'`,
`s3VectorsConfiguration.{indexArn,vectorBucketArn}`) with `embeddingModelArn` =
`amazon.titan-embed-text-v2:0`; the Guardrail uses `bedrock.CfnGuardrail` (PROMPT_ATTACK
`inputStrength: 'HIGH'` / `outputStrength: 'NONE'` + `piiEntitiesConfig` ANONYMIZE); chat handlers
bundle via `aws-lambda-nodejs.NodejsFunction` (esbuild, Node 20, Docker-free, with `esbuild` as a CDK
devDependency). The L2 `generative-ai-cdk-constructs` is rejected because its Bedrock module is
deprecated/frozen, and its successor `@aws-cdk/aws-bedrock-alpha` is experimental with unconfirmed S3
Vectors KB support — not acceptable for the PoC's grounding layer. Per spec §13, do **NOT** pre-build a
vector-store abstraction; this is one concrete L1 wiring.

> If `@aws-cdk/aws-bedrock-alpha` later confirms a stable S3 Vectors `VectorKnowledgeBase`, an L2 swap
> is a clean future refactor — but it is **not** a reason to abstract now.

---

## Open for the user (Console / account prerequisites)

1. **Enable Bedrock model access for Amazon Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`)
   in the Bedrock console for account 934939427723 / us-east-1 — carried over from S1 (a KB sync fails
   without it). Likewise enable access for the chat generation model (Nova Pro, enforcement D3).
2. **No preview enablement required** for S3 Vectors — it is GA in us-east-1 (S1), and the CDK L1
   `s3vectors` constructs + the `S3_VECTORS` storage type are GA in `aws-cdk-lib` (≥ ~2.257). Confirm the
   chat CDK app pins a recent enough `aws-cdk-lib`.
3. **Upgrade the local AWS CLI** (S1 flagged `aws-cli/2.3.5`, which lacks `s3vectors`/`bedrock`/
   `bedrock-agent`) before any CLI-based KB validation. Not a blocker for the CDK path itself.
4. **Validate the PROMPT_ATTACK guardrail synth/deploy early** (aws/aws-cdk#31919): the deploy-safe combo
   is `inputStrength: 'HIGH'` + `outputStrength: 'NONE'`; verify on first deploy.
5. **Stop using account root for deploys** (S1) — use the IAM default profile per repo deploy memory.

## Sources

- generative-ai-cdk-constructs — KB README (S3 Vectors `vectorStore`): https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/bedrock/knowledge-bases/README.md
- generative-ai-cdk-constructs — s3vectors README: https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/s3vectors/README.md
- generative-ai-cdk-constructs — Bedrock README (DEPRECATION notice): https://github.com/awslabs/generative-ai-cdk-constructs/blob/main/src/cdk-lib/bedrock/README.md
- aws-bedrock-alpha module docs (experimental successor): https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_alpha/README.html
- CDK L1 `s3vectors.CfnIndex`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3vectors.CfnIndex.html
- CDK L1 `s3vectors.CfnVectorBucket`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3vectors.CfnVectorBucket.html
- CFN KB StorageConfiguration (Type enum incl. `S3_VECTORS`): https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-storageconfiguration.html
- CFN KB S3VectorsConfiguration (IndexArn/IndexName/VectorBucketArn): https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-knowledgebase-s3vectorsconfiguration.html
- CDK tutorial — Bedrock KB with S3 Vector index (L1 trio): https://deepdive.codiply.com/bedrock-knowledge-base-with-s3-vector-index-in-aws-cdk
- CDK L1 `bedrock.CfnGuardrail`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrock.CfnGuardrail.html
- Bedrock prompt-attack guardrail docs: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html
- aws/aws-cdk#31919 (PROMPT_ATTACK strength friction): https://github.com/aws/aws-cdk/issues/31919
- CFN Guardrail SensitiveInformationPolicyConfig (PII ANONYMIZE): https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrock-guardrail-sensitiveinformationpolicyconfig.html
- CFN Guardrail resource: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrock-guardrail.html
- Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`, 1024 dims): https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
- Titan v2 + Bedrock KB GA: https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-titan-text-embeddings-v2-bedrock-knowledge-bases/
