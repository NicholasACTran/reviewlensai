# Phase 2 Analytics Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the analytics worker as a single EventBridge-triggered Lambda — CDK stack (rule → Lambda, S3 read, DLQ, alarms, SSM-fed config), the NLTK-bundled Lambda asset, and a `analytics-deploy.yml` workflow — so a `ScrapeSucceeded` event runs analytics end-to-end on staging.

**Architecture:** Mirrors the scraper exactly: a clean `build/` asset (worker package + vendored `nltk`/`requests` + bundled `nltk_data`), `Code.fromAsset("../build")`, jest CDK assertions, `cdk deploy` reading cross-domain SSM at synth. One async Lambda; EventBridge rule on the existing `reviewlensai` bus targets it; failures → SQS DLQ (alarmed). No Submitter, no Batch, no ECR (spec §6).

**Tech Stack:** AWS CDK (TypeScript), AWS Lambda (Python 3.12, ZIP), EventBridge, S3, SQS, CloudWatch, SSM, GitHub Actions, jest (CDK assertions).

**Spec:** `docs/specs/2026-06-01-phase-2-analytics-design.md` §6 (resources), §6.1 (SSM + bucket-policy precheck), §8 (retry/DLQ), §11 (NLTK smoke test), §12 (deploy).

**Prerequisites:** PR 3a (worker package `reviewlensai_analytics` with `main.handler`) merged; PR 2-A + 2-B deployed (schema fields live; `/reviewlensai/scraper/bucketName` published). The worker code is imported by the asset, so 3a must land first.

**Environment:** AWS CLI default profile, acct `934939427723`, `us-east-1`. CDK tests use jest (`scraper/cdk` precedent: `npm test`→jest). OneDrive blocks `.bin` shims → run jest via `node node_modules/jest/bin/jest.js`. `jq` unavailable locally → `aws --query/--output text`.

> **§6.1 pre-impl check (do FIRST, Task 1):** confirm the scraper bucket has **no restrictive resource (bucket) policy** that would override an identity-based `s3:GetObject` grant. If one exists, the analytics role's identity grant is insufficient and a scraper-stack bucket-policy change is required (a real cross-domain change to call out). Command in Task 1.

---

## File Structure (under `analytics/`)

- `cdk/lib/analytics-stack.ts` — the stack (rule, Lambda, S3 grant, DLQ, alarms).
- `cdk/bin/analytics.ts` — CDK app entrypoint.
- `cdk/test/analytics-stack.test.ts` — jest assertions.
- `cdk/package.json`, `cdk/cdk.json`, `cdk/tsconfig.json`, `cdk/jest.config.js` — mirror `scraper/cdk`.
- `.github/workflows/analytics-deploy.yml` — build asset (incl. NLTK data) + smoke test + cdk deploy.

---

## Task 1: §6.1 bucket-policy precheck + scaffold the CDK project

**Files:** `analytics/cdk/*` (mirror `scraper/cdk` config files).

- [ ] **Step 1: Bucket-policy precheck (decides whether an identity grant suffices)**

```bash
BUCKET=$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /reviewlensai/scraper/bucketName --query Parameter.Value --output text --region us-east-1) \
  && echo "bucket=$BUCKET" \
  && aws s3api get-bucket-policy --bucket "$BUCKET" --region us-east-1 2>&1 | head -20
```
Expected: `NoSuchBucketPolicy` (→ identity-based `s3:GetObject` grant is sufficient; proceed). If a policy IS returned, inspect it: an explicit `Deny` or a non-matching `Principal` condition means analytics reads would 403 — STOP and add a bucket-policy statement to the **scraper** stack granting the analytics role read on `jobs/*` (a cross-domain change; note it and coordinate). The scraper bucket is `BlockPublicAccess: ALL` but BPA does not affect intra-account IAM — only a resource policy would.

- [ ] **Step 2: Scaffold `analytics/cdk`** mirroring `scraper/cdk`. Copy `scraper/cdk/{cdk.json,tsconfig.json,jest.config.js,package.json}` and adjust: `package.json` name `reviewlensai-analytics-cdk`, same devDeps (`aws-cdk-lib`, `constructs`, `jest`, `ts-jest`, `@types/jest`, `typescript`, `aws-cdk`), `"test": "jest"`. `cdk.json` `"app": "npx ts-node --prefer-ts-exts bin/analytics.ts"`.

- [ ] **Step 3: `cdk/bin/analytics.ts`**
```ts
#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AnalyticsStack } from "../lib/analytics-stack";

const app = new App();
new AnalyticsStack(app, "reviewlensai-analytics-stack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
```

- [ ] **Step 4: Branch + HARD prerequisite check + install**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" && git switch main && git pull --ff-only \
  && test -f analytics/src/reviewlensai_analytics/main.py \
     || { echo "STOP: PR 3a (worker package) not merged to main — analytics/src/reviewlensai_analytics/main.py absent. The asset build, pytest, and Code.fromAsset('../build') all require it."; exit 1; } \
  && git switch -c phase2/analytics-infra \
  && (cd analytics/cdk && npm install)
```
Expected: the `test -f` passes (3a merged). If it fails, STOP — this plan cannot proceed until 3a is on `main`.

---

## Task 2: The CDK stack (TDD with jest assertions)

**Files:** `analytics/cdk/lib/analytics-stack.ts`, `analytics/cdk/test/analytics-stack.test.ts`

- [ ] **Step 1: Write the failing jest assertions**
```ts
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AnalyticsStack } from "../lib/analytics-stack";

function synth() {
  const app = new App({ context: {
    appsyncUrl: "https://x/graphql", appsyncApiKey: "k",
    eventBusName: "reviewlensai", bucketName: "scrape-bucket",
  }});
  return Template.fromStack(new AnalyticsStack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } }));
}

test("one analytics Lambda, python3.12, 600s, reserved concurrency 3", () => {
  const t = synth();
  t.resourceCountIs("AWS::Lambda::Function", 1);
  t.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "python3.12", Timeout: 600, ReservedConcurrentExecutions: 3,
    Handler: "reviewlensai_analytics.main.handler",
  });
});
test("EventBridge rule filters ScrapeSucceeded on the reviewlensai bus", () => {
  synth().hasResourceProperties("AWS::Events::Rule", {
    EventPattern: { source: ["reviewlensai.scraper"], "detail-type": ["ScrapeSucceeded"] },
  });
});
test("DLQ + two alarms", () => {
  const t = synth();
  t.resourceCountIs("AWS::SQS::Queue", 1);
  t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
});
test("Lambda env carries SSM-fed config + NLTK_DATA", () => {
  synth().hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ S3_BUCKET: "scrape-bucket", NLTK_DATA: "/var/task/nltk_data" }) },
  });
});
test("S3 read grant: s3:GetObject* scoped to jobs/*", () => {
  const t = synth();
  // grantRead renders the action as "s3:GetObject*" (the glob form), NOT "s3:GetObject".
  t.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: Match.arrayWith(["s3:GetObject*"]),
    })]) },
  });
  // Assert the grant is scoped to jobs/*, not the whole bucket (the title's actual claim).
  expect(JSON.stringify(t.toJSON())).toContain("jobs/*");
});
```

- [ ] **Step 2: Run jest → fail** (`cd analytics/cdk && node node_modules/jest/bin/jest.js`).

- [ ] **Step 3: Implement `analytics-stack.ts`**
```ts
import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";

export class AnalyticsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const ctx = (k: string) => this.node.tryGetContext(k);
    const appsyncUrl = ctx("appsyncUrl") ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/url");
    const appsyncApiKey = ctx("appsyncApiKey") ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/apiKey");
    const busName = ctx("eventBusName") ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/scraper/eventBusName");
    const bucketName = ctx("bucketName") ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/scraper/bucketName");

    const dlq = new sqs.Queue(this, "AnalyticsDlq", { retentionPeriod: Duration.days(14) });

    const fn = new lambda.Function(this, "AnalyticsFn", {
      runtime: Runtime.PYTHON_3_12,
      handler: "reviewlensai_analytics.main.handler",
      code: Code.fromAsset("../build"),   // CLEAN build dir from CI: package + vendored deps + nltk_data
      timeout: Duration.seconds(600),
      memorySize: 1024,
      reservedConcurrentExecutions: 3,
      environment: {
        APPSYNC_URL: appsyncUrl, APPSYNC_API_KEY: appsyncApiKey,
        S3_BUCKET: bucketName, NLTK_DATA: "/var/task/nltk_data",
      },
    });
    fn.configureAsyncInvoke({ retryAttempts: 0, onFailure: new SqsDestination(dlq) });

    // Cross-domain S3 read (by name; identity grant — §6.1 precheck confirmed no bucket policy).
    const bucket = s3.Bucket.fromBucketName(this, "ScrapeBucket", bucketName);
    bucket.grantRead(fn, "jobs/*");

    // Existing reviewlensai bus by NAME (not CFN import — scraper deploys never blocked; spec §6).
    const bus = events.EventBus.fromEventBusName(this, "ReviewLensBus", busName);
    new events.Rule(this, "AnalyticsRule", {
      eventBus: bus,
      eventPattern: { source: ["reviewlensai.scraper"], detailType: ["ScrapeSucceeded"] },
      targets: [new targets.LambdaFunction(fn)],
    });

    new cw.Alarm(this, "AnalyticsDlqDepthAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new cw.Alarm(this, "AnalyticsErrorsAlarm", {
      metric: fn.metricErrors(),
      threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
```
(Note: `events.Rule` with `detailType` renders `EventPattern["detail-type"]` — the test asserts the rendered key. `targets.LambdaFunction` auto-adds the `lambda:InvokeFunction` permission for the rule.)

- [ ] **Step 4: Run jest → pass; commit**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/analytics/cdk" && node node_modules/jest/bin/jest.js
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add analytics/cdk && git commit -m "feat(analytics): CDK stack (EventBridge rule -> Lambda, S3 read, DLQ, alarms)"
```

---

## Task 3: Deploy workflow with NLTK bundling + no-network smoke test

**Files:** `.github/workflows/analytics-deploy.yml`

- [ ] **Step 1: Create the workflow** (mirrors `scraper-deploy.yml` + NLTK data + the §11 smoke test)
```yaml
name: analytics-deploy
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - "analytics/**"
      - "!analytics/docs/**"
      - ".github/workflows/analytics-deploy.yml"
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Unit tests + lint
        working-directory: analytics
        run: |
          python -m pip install -e ".[dev]"
          python -m pytest -q
          ruff check src tests
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: "${{ secrets.AWS_DEPLOY_ROLE_ARN }}"
          aws-region: us-east-1
      - name: Build Lambda asset (CLEAN build dir: package + vendored deps + bundled nltk_data)
        working-directory: analytics
        run: |
          rm -rf build && mkdir -p build
          cp -r src/reviewlensai_analytics build/
          # Pin NLTK exactly — data-package names are version-sensitive (punkt_tab vs punkt).
          # Pin MUST match the worker pyproject's pinned nltk (spec §6 "pinned to an exact version").
          pip install "nltk==3.9.1" requests -t build/      # boto3 is in the Lambda runtime
          python -m nltk.downloader -d build/nltk_data \
            vader_lexicon averaged_perceptron_tagger_eng punkt_tab stopwords
      - name: NLTK bundle smoke test (spec §11 — catches a mis-bundle pre-deploy)
        working-directory: analytics/build
        env:
          PYTHONPATH: ${{ github.workspace }}/analytics/build
        run: |
          # NLTK reads data from the FILESYSTEM (never the network), so a socket hack proves
          # nothing. The real risk is the bundle resolving via a dev's ~/nltk_data fallback.
          # Pin nltk.data.path to ONLY the bundled dir, then import (VADER loads at import) + use.
          python -c "import nltk; nltk.data.path[:] = ['$PWD/nltk_data']; \
            import reviewlensai_analytics.sentiment as s, reviewlensai_analytics.words as w; \
            assert isinstance(s.compound('great game'), float); \
            assert w.top_adjectives(['brutal gorgeous game'], exclude=set()); \
            print('NLTK bundle resolves from build/nltk_data only')"
      - name: CDK unit tests + deploy (reads scraper+app SSM at synth — both must be deployed first)
        working-directory: analytics/cdk
        run: |
          npm ci
          npm test            # jest (../build exists)
          npx cdk deploy --require-approval never
```
(`NLTK_DATA=/var/task/nltk_data` at runtime — Lambda unzips `build/` to `/var/task`, so `build/nltk_data` lands at `/var/task/nltk_data`, matching the stack env.)

- [ ] **Step 2: YAML sanity + commit**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && python -c "import yaml; yaml.safe_load(open('.github/workflows/analytics-deploy.yml')); print('ok')" \
  && git add .github/workflows/analytics-deploy.yml \
  && git commit -m "ci(analytics): deploy workflow (NLTK bundle + no-network smoke test + cdk deploy)"
```

---

## Task 4: Open PR, deploy, E2E validate (gated on go-ahead)

**Files:** none.

- [ ] **Step 1: Push + PR + DA code review (CLAUDE.md 6.3); pause for go-ahead before merge** (deploy order: app + scraper already deployed → analytics is last).

- [ ] **Step 2: Merge → `analytics-deploy` runs.** Watch:
```bash
gh run watch $(gh run list --workflow analytics-deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- [ ] **Step 3: E2E (spec §11) — a real scrape now also produces analytics**
```bash
VURL=$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /reviewlensai/scraper/validatorUrl --query Parameter.Value --output text --region us-east-1) \
  && TABLE=$(aws dynamodb list-tables --region us-east-1 --query "TableNames[?starts_with(@,'Job-')]" --output text) \
  && RESP=$(curl -s -X POST "$VURL" -H 'content-type: application/json' -d '{"url":"https://store.steampowered.com/app/367520/Hollow_Knight/"}') \
  && JOB=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).jobId||'')" "$RESP") \
  && echo "jobId=$JOB" \
  && for i in $(seq 1 60); do \
       AST=$(aws dynamodb get-item --table-name "$TABLE" --region us-east-1 --key "{\"id\":{\"S\":\"$JOB\"}}" --query "Item.analyticsStatus.S" --output text 2>/dev/null); \
       echo "poll $i: analyticsStatus=$AST"; \
       [ "$AST" = "SUCCEEDED" ] && { echo "PASS: analytics produced"; break; }; \
       [ "$AST" = "FAILED" ] && { echo "FAIL: analytics FAILED — check CloudWatch"; break; }; \
       sleep 6; \
     done \
  && echo "--- analyticsJson present? ---" \
  && aws dynamodb get-item --table-name "$TABLE" --region us-east-1 --key "{\"id\":{\"S\":\"$JOB\"}}" --query "Item.analyticsJson.S" --output text | head -c 300
```
Expected: `analyticsStatus` reaches `SUCCEEDED` and `analyticsJson` is a JSON blob with the §5 keys. Watch the analytics Lambda CloudWatch logs alongside (structured `worker_*` events). **Rollback:** revert the merge + redeploy; the analytics stack is independent so a teardown leaves scraper/app untouched.

---

## Definition of Done (maps to spec §6/§11/§12)

- [ ] §6.1 bucket-policy precheck done (identity grant sufficient, or scraper bucket-policy change coordinated).
- [ ] CDK stack: 1 Lambda (py3.12/600s/reserved-3/retry-0+DLQ), EventBridge rule (ScrapeSucceeded on `reviewlensai`, by name), S3 read on `jobs/*`, 2 alarms; jest green.
- [ ] Asset bundles `reviewlensai_analytics` + `nltk`/`requests` + all 4 `nltk_data` packages; no-network smoke test green in CI.
- [ ] `analytics-deploy.yml` deploys after app+scraper; staging E2E: a scrape yields `analyticsStatus: SUCCEEDED` + `analyticsJson`.

---

## Self-Review notes
- **Spec coverage:** §6 resources→Task 2; §6.1 SSM+precheck→Task 1+stack ctx reads; §8 retry/DLQ→`configureAsyncInvoke`; §11 smoke→Task 3 Step; §12 deploy/order→Task 3+4. No gaps.
- **By-name bindings** (bus, bucket) avoid CFN cross-stack import locks (spec §6) — scraper deploys are never blocked by analytics; trade-off (stale name → silent non-trigger) is the accepted no-watchdog stance (§9).
- **One DLQ** via `configureAsyncInvoke` (EventBridge→Lambda is async, so Lambda async-failure config applies) — mirrors the scraper; no separate target DLQ needed.
- **NLTK_DATA path:** `build/nltk_data` → `/var/task/nltk_data` after Lambda unzip; stack env and the runtime agree. The no-network smoke test imports `sentiment` (VADER loads at import) under the bundled data — catches the import-time-crash risk flagged in the worker plan.
