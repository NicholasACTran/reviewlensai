import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HelpfulReviews } from "../../../src/components/analytics/HelpfulReviews";
import type { AnalyticsPayload, HelpfulReview } from "../../../src/types/analytics";
import fixture from "../../fixtures/analytics_payload.example.json";

const helpful = (fixture as unknown as AnalyticsPayload).helpful;

describe("HelpfulReviews", () => {
  it("renders a positive and a negative review's text", () => {
    render(<HelpfulReviews helpful={helpful} />);
    expect(screen.getAllByText(/brutal gorgeous combat great/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/terrible boring awful combat/i).length).toBeGreaterThan(0);
  });

  it("shows a 'No reviews' note for an empty column", () => {
    render(<HelpfulReviews helpful={{ positive: helpful.positive, negative: [] }} />);
    expect(screen.getByText(/no reviews/i)).toBeInTheDocument();
  });

  it("renders the language chip for a non-english review", () => {
    const fr: HelpfulReview = {
      text: "Jeu magnifique.",
      votesUp: 10,
      votesFunny: 3,
      votedUp: true,
      createdAt: 1700000000,
      language: "french",
      playtimeForeverHours: 5,
    };
    render(<HelpfulReviews helpful={{ positive: [fr], negative: [] }} />);
    expect(screen.getByText("french")).toBeInTheDocument();
    expect(screen.getByText(/😄 3/)).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
  });
});
