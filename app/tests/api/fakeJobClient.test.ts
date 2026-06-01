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
