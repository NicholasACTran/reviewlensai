// @vitest-environment node
import { describe, it, expect } from "vitest";
import { schema } from "../../amplify/data/resource";

// Guards the spec's nullability rule without deploying. We assert on the
// schema's serialized field definitions exposed by the Amplify schema builder.
describe("Job schema", () => {
  it("declares pctPositive and price as NON-required (nullable)", () => {
    const job = (schema as any).data.types.Job.data.fields;
    expect(job.pctPositive.data.required).not.toBe(true);
    expect(job.price.data.required).not.toBe(true);
  });
  it("requires id-bound core fields steamUrl/appId", () => {
    const job = (schema as any).data.types.Job.data.fields;
    expect(job.steamUrl.data.required).toBe(true);
    expect(job.appId.data.required).toBe(true);
  });
  // status is an a.enum() field — the builder represents it as { type: "enum", values: [...] }
  // (no .data.required property). Assert presence + correct values instead.
  it("status field is an enum with the correct values", () => {
    const job = (schema as any).data.types.Job.data.fields;
    expect(job.status.type).toBe("enum");
    expect(job.status.values).toEqual(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
  });
});

import type { Schema } from "../../amplify/data/resource";
import type { Job } from "../../src/types/job";

it("generated Job type structurally covers the hand-rolled Job", () => {
  // Compile-time check: assignability. Runtime body is a no-op.
  const _check = (g: Schema["Job"]["type"]): void => {
    const _j: Pick<Job, "id" | "status" | "steamUrl" | "appId"> = {
      id: g.id, status: g.status as Job["status"], steamUrl: g.steamUrl, appId: g.appId,
    };
    void _j;
  };
  void _check;
  expect(true).toBe(true);
});
