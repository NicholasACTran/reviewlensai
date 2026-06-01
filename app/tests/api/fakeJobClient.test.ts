import { describe, it, expect, vi } from "vitest";
import { FakeJobClient } from "../../src/api/fakeJobClient";

describe("FakeJobClient", () => {
  it("emits [] then walks PENDING→RUNNING→SUCCEEDED", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 100, outcome: "SUCCEEDED" });
    const snapshots: string[][] = [];
    const sub = client.observeJob("j1").subscribe((items) => snapshots.push(items.map((i) => i.status)));

    // seed the row (as the Validator would have)
    client.seed({ id: "j1", appId: "1", steamUrl: "u", gameName: "Game", headerImage: null, price: "$10" });
    await vi.advanceTimersByTimeAsync(350);
    sub.unsubscribe();
    vi.useRealTimers();

    expect(snapshots[0]).toEqual([]);                 // initial empty snapshot
    const flat = snapshots.map((s) => s[0]).filter(Boolean);
    expect(flat).toContain("PENDING");
    expect(flat).toContain("RUNNING");
    expect(flat[flat.length - 1]).toBe("SUCCEEDED");
  });

  it("drives analyticsStatus RUNNING → SUCCEEDED with a payload after the scrape succeeds", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 100, outcome: "SUCCEEDED" });
    const analyticsStates: (string | null)[] = [];
    let last: any;
    const sub = client.observeJob("ja").subscribe((items) => {
      if (items[0]) { analyticsStates.push(items[0].analyticsStatus); last = items[0]; }
    });
    client.seed({ id: "ja", appId: "1", steamUrl: "u" });
    await vi.advanceTimersByTimeAsync(500);
    sub.unsubscribe();
    vi.useRealTimers();

    const seen = analyticsStates.filter(Boolean);
    expect(seen).toContain("RUNNING");
    expect(seen[seen.length - 1]).toBe("SUCCEEDED");
    expect(last.analyticsStatus).toBe("SUCCEEDED");
    expect(last.analyticsJson).not.toBeNull();
    expect(JSON.parse(last.analyticsJson).hasData).toBe(true);
  });

  it("leaves analyticsStatus null when analyticsOutcome is 'none'", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 50, outcome: "SUCCEEDED", analyticsOutcome: "none" });
    let last: any;
    const sub = client.observeJob("jn").subscribe((items) => (last = items[0]));
    client.seed({ id: "jn", appId: "1", steamUrl: "u" });
    await vi.advanceTimersByTimeAsync(400);
    sub.unsubscribe();
    vi.useRealTimers();
    expect(last.status).toBe("SUCCEEDED");
    expect(last.analyticsStatus).toBeNull();
    expect(last.analyticsJson).toBeNull();
  });

  it("can produce an analytics FAILED outcome", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 50, outcome: "SUCCEEDED", analyticsOutcome: "FAILED" });
    let last: any;
    const sub = client.observeJob("jf").subscribe((items) => (last = items[0]));
    client.seed({ id: "jf", appId: "1", steamUrl: "u" });
    await vi.advanceTimersByTimeAsync(400);
    sub.unsubscribe();
    vi.useRealTimers();
    expect(last.analyticsStatus).toBe("FAILED");
    expect(last.analyticsErrorMessage).toBe("Analytics failed.");
    expect(last.analyticsJson).toBeNull();
  });

  it("can produce a FAILED outcome with an errorMessage", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 50, outcome: "FAILED", errorMessage: "Scrape failed. Try again." });
    let last: any;
    const sub = client.observeJob("j2").subscribe((items) => (last = items[0]));
    client.seed({ id: "j2", appId: "2", steamUrl: "u" });
    await vi.advanceTimersByTimeAsync(200);
    sub.unsubscribe(); vi.useRealTimers();
    expect(last.status).toBe("FAILED");
    expect(last.errorMessage).toBe("Scrape failed. Try again.");
  });
});
