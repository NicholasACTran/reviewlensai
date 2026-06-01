import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJob } from "../../src/hooks/useJob";
import { FakeJobClient } from "../../src/api/fakeJobClient";

describe("useJob", () => {
  it("is waiting before the row exists and through RUNNING, then nominal", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 100, outcome: "SUCCEEDED" });
    const { result } = renderHook(() => useJob(client, "j1", 999_999));
    expect(result.current.kind).toBe("waiting");          // items: []
    act(() => client.seed({ id: "j1", appId: "1", steamUrl: "u", gameName: "G" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(result.current.kind).toBe("nominal");
    vi.useRealTimers();
  });

  it("flips to tryagain after the staleness timeout with no transition", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 10_000_000 }); // never transitions in window
    const { result } = renderHook(() => useJob(client, "j2", 1000));
    act(() => client.seed({ id: "j2", appId: "2", steamUrl: "u" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current.kind).toBe("tryagain");
    vi.useRealTimers();
  });
});
