import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { FunctionUrlAuthType, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";

export class ScraperStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Cross-domain inputs (spec §6) — read at synth from SSM (context override in tests).
    const appsyncUrl = this.node.tryGetContext("appsyncUrl")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/url");
    const appsyncApiKey = this.node.tryGetContext("appsyncApiKey")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/appsync/apiKey");
    const amplifyUrl = this.node.tryGetContext("amplifyUrl")
      ?? ssm.StringParameter.valueForStringParameter(this, "/reviewlensai/amplify/url");

    const bucket = new s3.Bucket(this, "ScrapeBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ prefix: "jobs/", expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bus = new events.EventBus(this, "ReviewLensBus", { eventBusName: "reviewlensai" });

    const dlq = new sqs.Queue(this, "ScraperDlq", { retentionPeriod: Duration.days(14) });

    // Asset is a CLEAN build dir populated by CI (Task 8): reviewlensai_scraper/ + vendored deps,
    // NEVER the source tree (keeps `requests` out of src/ and the asset hash stable).
    const code = Code.fromAsset("../build");
    const commonEnv = { APPSYNC_URL: appsyncUrl, APPSYNC_API_KEY: appsyncApiKey };

    const scraperFn = new lambda.Function(this, "ScraperFn", {
      runtime: Runtime.PYTHON_3_12,
      handler: "reviewlensai_scraper.scraper.handler",
      code,
      timeout: Duration.seconds(600),
      memorySize: 1024,
      reservedConcurrentExecutions: 3,
      environment: {
        ...commonEnv,
        S3_BUCKET: bucket.bucketName,
        EVENT_BUS_NAME: bus.eventBusName,
        MAX_REVIEWS: "10000",
      },
    });
    scraperFn.configureAsyncInvoke({ retryAttempts: 0, onFailure: new SqsDestination(dlq) });
    bucket.grantPut(scraperFn);
    bus.grantPutEventsTo(scraperFn);

    const validatorFn = new lambda.Function(this, "ValidatorFn", {
      runtime: Runtime.PYTHON_3_12,
      handler: "reviewlensai_scraper.validator.handler",
      code,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonEnv,
        ALLOWED_ORIGIN: amplifyUrl,
        SCRAPER_FUNCTION_NAME: scraperFn.functionName,
      },
    });
    scraperFn.grantInvoke(validatorFn);

    const url = validatorFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      // The Function URL auto-handles the CORS OPTIONS preflight from this config — OPTIONS is NOT
      // a valid allowedMethods value (CloudFormation rejects it); listing POST + the allowed
      // origin/headers is what makes the browser preflight succeed.
      cors: {
        allowedOrigins: [amplifyUrl],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["content-type"],
      },
    });

    // Alarms (spec §4.4): DLQ depth + scraper errors. NOT_BREACHING avoids INSUFFICIENT_DATA noise
    // on sparse SQS/Lambda metrics.
    new cw.Alarm(this, "DlqDepthAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new cw.Alarm(this, "ScraperErrorsAlarm", {
      metric: scraperFn.metricErrors(),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Outputs back to the contract (spec §6).
    new ssm.StringParameter(this, "EventBusNameParam", {
      parameterName: "/reviewlensai/scraper/eventBusName",
      stringValue: bus.eventBusName,
    });
    new ssm.StringParameter(this, "ValidatorUrlParam", {
      parameterName: "/reviewlensai/scraper/validatorUrl",
      stringValue: url.url,
    });
  }
}
