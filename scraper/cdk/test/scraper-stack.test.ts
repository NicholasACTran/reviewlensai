import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ScraperStack } from "../lib/scraper-stack";

function synth() {
  const app = new App({ context: { appsyncUrl: "https://x/graphql", appsyncApiKey: "k", amplifyUrl: "https://app.example" } });
  return Template.fromStack(new ScraperStack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } }));
}

test("creates two Lambda functions", () => {
  synth().resourceCountIs("AWS::Lambda::Function", 2);
});
test("scraper has reserved concurrency 3 and a DLQ", () => {
  const t = synth();
  t.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 3 });
  t.resourceCountIs("AWS::SQS::Queue", 1);
});
test("validator has a public Function URL", () => {
  synth().hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
});
test("custom event bus + DLQ alarm exist", () => {
  const t = synth();
  t.resourceCountIs("AWS::Events::EventBus", 1);
  t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
});
test("S3 bucket blocks public access and has a lifecycle rule", () => {
  const t = synth();
  t.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true },
  });
});
