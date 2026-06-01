import { describe, it, expect } from "vitest";
import { toJobView, type Job } from "../../src/types/job";

const base: Job = {
  id: "j1", status: "PENDING", steamUrl: "https://store.steampowered.com/app/1/X/",
  appId: "1", gameName: null, headerImage: null, price: null,
  totalReviews: null, pctPositive: null, scrapedReviews: null, s3Key: null, errorMessage: null,
};

describe("toJobView", () => {
  it("maps PENDING/RUNNING to waiting", () => {
    expect(toJobView(base).kind).toBe("waiting");
    expect(toJobView({ ...base, status: "RUNNING" }).kind).toBe("waiting");
  });
  it("maps SUCCEEDED to nominal with display fields", () => {
    const v = toJobView({ ...base, status: "SUCCEEDED", gameName: "X", totalReviews: 0, pctPositive: null });
    expect(v.kind).toBe("nominal");
    if (v.kind === "nominal") { expect(v.gameName).toBe("X"); expect(v.totalReviews).toBe(0); expect(v.pctPositive).toBeNull(); }
  });
  it("maps FAILED to tryagain with message", () => {
    const v = toJobView({ ...base, status: "FAILED", errorMessage: "Scrape failed. Try again." });
    expect(v.kind).toBe("tryagain");
    if (v.kind === "tryagain") expect(v.message).toBe("Scrape failed. Try again.");
  });
});
