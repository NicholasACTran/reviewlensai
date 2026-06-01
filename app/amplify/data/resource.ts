import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

export const schema = a.schema({
  Job: a
    .model({
      status: a.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
      steamUrl: a.string().required(),
      appId: a.string().required(),
      gameName: a.string(),
      headerImage: a.string(),
      price: a.string(),               // nullable (free games)
      totalReviews: a.integer(),
      pctPositive: a.float(),          // nullable — null iff totalReviews == 0 (spec §3)
      scrapedReviews: a.integer(),
      s3Key: a.string(),
      errorMessage: a.string(),
      expiresAt: a.integer(),          // TTL attribute (epoch seconds)
    })
    .authorization((allow) => [allow.publicApiKey()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    apiKeyAuthorizationMode: { expiresInDays: 365 }, // spec §5.1 / §11 risk
  },
});
