import { describe, it, expect, vi } from "vitest";
import { AmplifyJobClient } from "../../src/api/amplifyJobClient";

describe("AmplifyJobClient", () => {
  it("forwards observeQuery snapshots as Job[] and filters by id", () => {
    const fakeModels = {
      Job: {
        observeQuery: vi.fn(() => ({
          subscribe: (cb: any) => { cb({ items: [{ id: "j1", status: "RUNNING", steamUrl: "u", appId: "1" }], isSynced: true }); return { unsubscribe() {} }; },
        })),
      },
    };
    const client = new AmplifyJobClient(fakeModels as any);
    let got: any[] = [];
    client.observeJob("j1").subscribe((items) => (got = items));
    expect(fakeModels.Job.observeQuery).toHaveBeenCalledWith({ filter: { id: { eq: "j1" } } });
    expect(got[0].status).toBe("RUNNING");
  });

  it("maps the analytics fields from the raw row (real-path contract guard)", () => {
    const raw = { id: "j2", status: "SUCCEEDED", steamUrl: "u", appId: "1",
      analyticsStatus: "SUCCEEDED", analyticsErrorMessage: null, analyticsJson: '{"hasData":true}' };
    const models = { Job: { observeQuery: vi.fn(() => ({
      subscribe: (cb: any) => { cb({ items: [raw], isSynced: true }); return { unsubscribe() {} }; },
    })) } };
    let got: any[] = [];
    new AmplifyJobClient(models as any).observeJob("j2").subscribe((items) => (got = items));
    expect(got[0].analyticsStatus).toBe("SUCCEEDED");
    expect(got[0].analyticsErrorMessage).toBeNull();
    expect(got[0].analyticsJson).toBe('{"hasData":true}');
  });

  it("defaults the analytics fields to null when the raw row omits them", () => {
    const models = { Job: { observeQuery: vi.fn(() => ({
      subscribe: (cb: any) => { cb({ items: [{ id: "j3", status: "RUNNING", steamUrl: "u", appId: "1" }], isSynced: true }); return { unsubscribe() {} }; },
    })) } };
    let got: any[] = [];
    new AmplifyJobClient(models as any).observeJob("j3").subscribe((items) => (got = items));
    expect(got[0].analyticsStatus).toBeNull();
    expect(got[0].analyticsErrorMessage).toBeNull();
    expect(got[0].analyticsJson).toBeNull();
  });
});
