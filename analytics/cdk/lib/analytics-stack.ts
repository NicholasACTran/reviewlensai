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
      code: Code.fromAsset("../build"),
      timeout: Duration.seconds(600),
      memorySize: 1024,
      reservedConcurrentExecutions: 3,
      environment: {
        APPSYNC_URL: appsyncUrl, APPSYNC_API_KEY: appsyncApiKey,
        S3_BUCKET: bucketName, NLTK_DATA: "/var/task/nltk_data",
        EVENT_BUS_NAME: busName,
      },
    });
    fn.configureAsyncInvoke({ retryAttempts: 0, onFailure: new SqsDestination(dlq) });

    const bucket = s3.Bucket.fromBucketName(this, "ScrapeBucket", bucketName);
    bucket.grantRead(fn, "jobs/*");

    const bus = events.EventBus.fromEventBusName(this, "ReviewLensBus", busName);
    bus.grantPutEventsTo(fn);
    new events.Rule(this, "AnalyticsRule", {
      eventBus: bus,
      eventPattern: { source: ["reviewlensai.scraper"], detailType: ["ScrapeSucceeded"] },
      // Two distinct retry layers: (1) Lambda async-invoke (configureAsyncInvoke above) governs
      // EXECUTION failures (handler threw) -> retry 0 -> dlq. (2) This EventBridge target retry
      // governs DELIVERY failures (e.g. the invoke is throttled under reservedConcurrency:3 when
      // scrapes finish in a burst). Leaving it at the AWS default would retry delivery for 24h /
      // 185 attempts; bound it to 2 and route exhausted deliveries to the SAME dlq so a sustained
      // throttle is captured rather than silently dropped.
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 2, deadLetterQueue: dlq })],
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
