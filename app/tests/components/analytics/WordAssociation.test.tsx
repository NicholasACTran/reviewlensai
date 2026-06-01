import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WordAssociation } from "../../../src/components/analytics/WordAssociation";
import type { AnalyticsPayload } from "../../../src/types/analytics";
import fixture from "../../fixtures/analytics_payload.example.json";

const words = (fixture as unknown as AnalyticsPayload).words;

describe("WordAssociation", () => {
  it("shows the overall lens terms by default", () => {
    render(<WordAssociation words={words} />);
    expect(screen.getByRole("button", { name: /overall/i })).toHaveAttribute("aria-pressed", "true");
    // overallPhrases-only term
    expect(screen.getByText("boring awful")).toBeInTheDocument();
  });

  it("swaps terms and aria-pressed when switching to the complaint lens", async () => {
    const user = userEvent.setup();
    render(<WordAssociation words={words} />);
    // praisePhrases-only term present in overall? "adventure exciting" only appears under praise.
    expect(screen.queryByText("adventure exciting")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /complaint/i }));
    expect(screen.getByRole("button", { name: /complaint/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /overall/i })).toHaveAttribute("aria-pressed", "false");
    // complaintPhrases-only term
    expect(screen.getByText("awful combat")).toBeInTheDocument();
  });

  it("renders a dash for an empty list under the active lens", async () => {
    const user = userEvent.setup();
    const empty = {
      ...words,
      complaintAdjectives: [],
      complaintPhrases: [],
    } as AnalyticsPayload["words"];
    render(<WordAssociation words={empty} />);
    // overall lens has data → no dash yet
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /complaint/i }));
    // both adjective + phrase groups are empty under complaint → two dashes
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
