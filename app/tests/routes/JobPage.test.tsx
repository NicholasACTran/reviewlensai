import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { JobView as JobViewRenderer } from "../../src/routes/JobPage";
import { FakeJobClient } from "../../src/api/fakeJobClient";

describe("JobPage view", () => {
  it("renders waiting → nominal numbers", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 50, outcome: "SUCCEEDED" });
    render(<MemoryRouter><JobViewRenderer client={client} id="j1" /></MemoryRouter>);
    expect(screen.getByText(/analy[sz]ing/i)).toBeInTheDocument();
    act(() => client.seed({ id: "j1", appId: "1", steamUrl: "u", gameName: "Stardew Valley" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(screen.getByText("Stardew Valley")).toBeInTheDocument();
    expect(screen.getByText(/1[,.]?234/)).toBeInTheDocument();
    expect(screen.getByText(/92%/)).toBeInTheDocument();
    vi.useRealTimers();
  });
  it("renders try-again on FAILED", async () => {
    vi.useFakeTimers();
    const client = new FakeJobClient({ stepMs: 50, outcome: "FAILED", errorMessage: "Couldn't reach Steam. Try again." });
    render(<MemoryRouter><JobViewRenderer client={client} id="j2" /></MemoryRouter>);
    act(() => client.seed({ id: "j2", appId: "2", steamUrl: "u" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(screen.getByText("Couldn't reach Steam. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
