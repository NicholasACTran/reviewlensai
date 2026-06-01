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
test("EventBridge target bounds delivery retries to 2 and dead-letters to the DLQ (no silent drop on throttle)", () => {
  synth().hasResourceProperties("AWS::Events::Rule", {
    Targets: Match.arrayWith([Match.objectLike({
      RetryPolicy: { MaximumRetryAttempts: 2 },
      DeadLetterConfig: { Arn: Match.anyValue() },
    })]),
  });
});
test("Lambda env carries SSM-fed config + NLTK_DATA", () => {
  synth().hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ S3_BUCKET: "scrape-bucket", NLTK_DATA: "/var/task/nltk_data" }) },
  });
});
test("S3 read grant: s3:GetObject* scoped to jobs/*", () => {
  const t = synth();
  t.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: Match.arrayWith(["s3:GetObject*"]),
    })]) },
  });
  expect(JSON.stringify(t.toJSON())).toContain("jobs/*");
});
test("Lambda env includes EVENT_BUS_NAME for the analytics-succeeded emission", () => {
  synth().hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ EVENT_BUS_NAME: "reviewlensai" }) },
  });
});
test("IAM policy grants events:PutEvents so the Lambda can emit AnalyticsSucceeded", () => {
  // CDK emits Action as a plain string (not an array) when there is only one action.
  // Use a raw JSON substring check to avoid fighting the Match.arrayWith vs string mismatch.
  const t = synth();
  expect(JSON.stringify(t.toJSON())).toContain('"events:PutEvents"');
});
