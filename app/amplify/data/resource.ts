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
      // Phase 2 analytics — sole writer is the Analytics Lambda. The attribute is
      // ABSENT (not NULL) until analytics starts; the worker's idempotency guard
      // uses attribute_not_exists (spec §3/§7). analyticsStatus is a.string()
      // (NOT a.enum) so its ModelStringInput exposes attributeExists (spec §16);
      // values are the closed set "RUNNING"|"SUCCEEDED"|"FAILED".
      analyticsStatus: a.string(),
      analyticsErrorMessage: a.string(),   // nullable; closed error set (spec §8)
      analyticsJson: a.string(),           // nullable; JSON-stringified AnalyticsPayload (spec §5)
      // Phase 3 chat — sole writer is the ChatIngester Lambda. ABSENT (not NULL)
      // until ingestion starts; the ingester's idempotency guard uses
      // attribute_not_exists(chatStatus). a.string() (NOT a.enum) so ModelStringInput
      // exposes attributeExists; values are the closed set "RUNNING"|"SUCCEEDED"|"FAILED".
      chatStatus: a.string(),
      chatErrorMessage: a.string(),   // nullable; closed error set (enforcement spec §10)
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
