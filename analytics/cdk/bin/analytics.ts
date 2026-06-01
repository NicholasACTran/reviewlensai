#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AnalyticsStack } from "../lib/analytics-stack";

const app = new App();
new AnalyticsStack(app, "reviewlensai-analytics-stack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
