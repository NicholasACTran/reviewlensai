#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ScraperStack } from "../lib/scraper-stack";

const app = new App();
new ScraperStack(app, "ReviewLensScraperStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
