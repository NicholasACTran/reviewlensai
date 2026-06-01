import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SentimentChart } from "../../../src/components/analytics/SentimentChart";
import type { AnalyticsPayload } from "../../../src/types/analytics";
import fixture from "../../fixtures/analytics_payload.example.json";

// Recharts' ResponsiveContainer measures layout (0x0 in jsdom) and renders nothing; passthrough it.
vi.mock("recharts", async (orig) => ({
  ...(await orig<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
}));

const base = fixture as unknown as AnalyticsPayload;

describe("SentimentChart", () => {
  it("shows the 'most recent N' caption only when coversFullHistory is false", () => {
    const partial = { ...base, coversFullHistory: false, totalAnalyzed: 1234 } as AnalyticsPayload;
    const { rerender } = render(<SentimentChart data={partial} />);
    expect(screen.getByText(/most recent 1,234 reviews/i)).toBeInTheDocument();

    const full = { ...base, coversFullHistory: true } as AnalyticsPayload;
    rerender(<SentimentChart data={full} />);
    expect(screen.queryByText(/most recent/i)).not.toBeInTheDocument();
  });

  it("flips aria-pressed when toggling weekly/monthly", async () => {
    const user = userEvent.setup();
    render(<SentimentChart data={base} />);
    const weekly = screen.getByRole("button", { name: /weekly/i });
    const monthly = screen.getByRole("button", { name: /monthly/i });
    expect(weekly).toHaveAttribute("aria-pressed", "true");
    expect(monthly).toHaveAttribute("aria-pressed", "false");
    await user.click(monthly);
    expect(weekly).toHaveAttribute("aria-pressed", "false");
    expect(monthly).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the English-gate empty state when there are no weekly buckets", () => {
    const noWeeks = { ...base, sentiment: { weekly: [], analyzedAvgCompound: null } } as AnalyticsPayload;
    render(<SentimentChart data={noWeeks} />);
    expect(screen.getByText(/not enough english-language reviews/i)).toBeInTheDocument();
  });
});
