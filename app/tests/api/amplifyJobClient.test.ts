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
});
