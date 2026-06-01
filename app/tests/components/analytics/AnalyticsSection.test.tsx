import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalyticsSection } from "../../../src/components/analytics/AnalyticsSection";
import type { AnalyticsPayload } from "../../../src/types/analytics";
import fixture from "../../fixtures/analytics_payload.example.json";

const payload = fixture as unknown as AnalyticsPayload;

describe("AnalyticsSection", () => {
  it("renders nothing when status is null", () => {
    const { container } = render(
      <AnalyticsSection status={null} errorMessage={null} analytics={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a loading note while RUNNING", () => {
    render(<AnalyticsSection status="RUNNING" errorMessage={null} analytics={null} />);
    expect(screen.getByText(/analyzing reviews/i)).toBeInTheDocument();
  });

  it("shows an unavailable note when FAILED", () => {
    render(<AnalyticsSection status="FAILED" errorMessage="boom" analytics={null} />);
    expect(screen.getByText(/analytics unavailable/i)).toBeInTheDocument();
  });

  it("shows the empty note when SUCCEEDED but hasData is false", () => {
    const empty = { ...payload, hasData: false } as AnalyticsPayload;
    render(<AnalyticsSection status="SUCCEEDED" errorMessage={null} analytics={empty} />);
    expect(screen.getByText(/not enough reviews to analyze/i)).toBeInTheDocument();
  });

  it("renders all three children when SUCCEEDED with data", () => {
    render(<AnalyticsSection status="SUCCEEDED" errorMessage={null} analytics={payload} />);
    // SentimentChart toggle
    expect(screen.getByRole("button", { name: /weekly/i })).toBeInTheDocument();
    // WordAssociation term
    expect(screen.getAllByText("gorgeous").length).toBeGreaterThan(0);
    // HelpfulReviews snippet
    expect(screen.getAllByText(/brutal gorgeous combat/i).length).toBeGreaterThan(0);
  });
});
