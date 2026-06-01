import { defineBackend } from "@aws-amplify/backend";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { data } from "./data/resource";

const backend = defineBackend({ data });

// backend.data is AmplifyData (alias for AmplifyGraphqlApi), which exposes:
//   .graphqlUrl  — confirmed in @aws-amplify/graphql-api-construct amplify-graphql-api.d.ts line 63
//   .stack       — confirmed in @aws-amplify/graphql-api-construct amplify-graphql-api.d.ts line 50
//   .resources.cfnResources.cfnApiKey — confirmed as optional CfnApiKey in types.d.ts line 694
const dataStack = backend.data.stack;
const cfnApiKey = backend.data.resources.cfnResources.cfnApiKey;

new StringParameter(dataStack, "AppSyncUrlParam", {
  parameterName: "/reviewlensai/appsync/url",
  stringValue: backend.data.graphqlUrl,
});

new StringParameter(dataStack, "AppSyncApiKeyParam", {
  parameterName: "/reviewlensai/appsync/apiKey",
  // cfnApiKey is optional (only present when API key auth is enabled); we assert non-null
  // because the schema uses allow.publicApiKey() which always generates the key.
  stringValue: cfnApiKey!.attrApiKey,
});
