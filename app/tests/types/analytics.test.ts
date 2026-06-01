import { describe, it, expect } from "vitest";
import { parseAnalytics, type AnalyticsPayload } from "../../src/types/analytics";
import fixture from "../fixtures/analytics_payload.example.json";

describe("parseAnalytics", () => {
  it("parses a valid payload string", () => {
    const p = parseAnalytics(JSON.stringify(fixture)) as AnalyticsPayload;
    expect(p.hasData).toBe(true);
    expect(Array.isArray(p.sentiment.weekly)).toBe(true);
    expect(Array.isArray(p.words.praiseAdjectives)).toBe(true);
  });
  it("returns null for null/empty/garbage (never throws)", () => {
    expect(parseAnalytics(null)).toBeNull();
    expect(parseAnalytics("")).toBeNull();
    expect(parseAnalytics("not json")).toBeNull();
    expect(parseAnalytics(JSON.stringify({ nope: 1 }))).toBeNull();
  });
  it("the shared fixture has the exact contract shape (cross-domain drift guard)", () => {
    expect(new Set(Object.keys(fixture))).toEqual(new Set([
      "hasData","coversFullHistory","totalAnalyzed","englishReviewCount","sentiment","words","helpful"]));
    expect(new Set(Object.keys(fixture.words))).toEqual(new Set([
      "overallAdjectives","overallPhrases","praiseAdjectives","praisePhrases","complaintAdjectives","complaintPhrases"]));
  });
});
