import type { AnalyticsStatus, Job, JobStatus } from "../types/job";
import type { JobClient, Observable } from "./jobClient";

interface FakeOpts {
  stepMs?: number;
  outcome?: "SUCCEEDED" | "FAILED";
  errorMessage?: string;
  analyticsOutcome?: "SUCCEEDED" | "FAILED" | "none";
}
type Seed = Partial<Job> & { id: string; appId: string; steamUrl: string };

// Self-contained sample payload (src must NOT import the tests/ fixture). Hollow-Knight-ish;
// coversFullHistory:false so the live fake view shows the "most recent N reviews" caption.
const ANALYTICS_JSON = JSON.stringify({
  hasData: true, coversFullHistory: false, totalAnalyzed: 1234, englishReviewCount: 1100,
  sentiment: {
    weekly: [
      { period: "2024-W02", avgCompound: 0.5, reviewCount: 800 },
      { period: "2024-W03", avgCompound: 0.3, reviewCount: 434 },
    ],
    analyzedAvgCompound: 0.42,
  },
  words: {
    overallAdjectives: [{ term: "gorgeous", count: 210 }], overallPhrases: [{ term: "boss fight", count: 90 }],
    praiseAdjectives: [{ term: "tight", count: 150 }], praisePhrases: [{ term: "hand drawn", count: 40 }],
    complaintAdjectives: [{ term: "brutal", count: 60 }], complaintPhrases: [{ term: "vague map", count: 20 }],
  },
  helpful: {
    positive: [{ text: "Best metroidvania.", votesUp: 312, votesFunny: 5, votedUp: true, createdAt: 1700000000, language: "english", playtimeForeverHours: 60 }],
    negative: [{ text: "DLC spike too hard.", votesUp: 88, votesFunny: 2, votedUp: false, createdAt: 1700000000, language: "english", playtimeForeverHours: 12 }],
  },
});

export class FakeJobClient implements JobClient {
  private rows = new Map<string, Job>();
  private listeners = new Map<string, ((items: Job[]) => void)[]>();
  private opts: Required<Pick<FakeOpts, "stepMs" | "outcome" | "analyticsOutcome">> & Pick<FakeOpts, "errorMessage">;

  constructor(opts: FakeOpts = {}) {
    this.opts = {
      stepMs: opts.stepMs ?? 1200,
      outcome: opts.outcome ?? "SUCCEEDED",
      analyticsOutcome: opts.analyticsOutcome ?? "SUCCEEDED",
      errorMessage: opts.errorMessage,
    };
  }

  observeJob(id: string): Observable<Job[]> {
    return {
      subscribe: (next) => {
        const arr = this.listeners.get(id) ?? [];
        arr.push(next); this.listeners.set(id, arr);
        next(this.rows.has(id) ? [this.rows.get(id)!] : []); // initial snapshot (possibly [])
        return { unsubscribe: () => { const a = this.listeners.get(id)!; a.splice(a.indexOf(next), 1); } };
      },
    };
  }

  /** Simulate the Validator creating the row, then the Scraper's lifecycle. */
  seed(seed: Seed): void {
    const row: Job = {
      gameName: null, headerImage: null, price: null, totalReviews: null, pctPositive: null,
      scrapedReviews: null, s3Key: null, errorMessage: null,
      analyticsStatus: null, analyticsErrorMessage: null, analyticsJson: null, ...seed, status: "PENDING",
    };
    this.set(seed.id, row);
    this.schedule(seed.id, 1, "RUNNING");
    this.schedule(seed.id, 2, this.opts.outcome);
    // Analytics only runs once the scrape SUCCEEDED (mirrors the backend lifecycle). Chain the two
    // analytics writes on the same setTimeout-by-step mechanism as the scrape writes above.
    if (this.opts.outcome === "SUCCEEDED" && this.opts.analyticsOutcome !== "none") {
      this.scheduleAnalytics(seed.id, 3, "RUNNING");
      this.scheduleAnalytics(seed.id, 4, this.opts.analyticsOutcome);
    }
  }

  private schedule(id: string, n: number, status: JobStatus) {
    setTimeout(() => {
      const cur = this.rows.get(id); if (!cur) return;
      const next: Job = { ...cur, status };
      if (status === "SUCCEEDED") { next.gameName = cur.gameName ?? "Sample Game"; next.totalReviews = 1234; next.pctPositive = 0.92; next.scrapedReviews = 1234; next.s3Key = `jobs/${id}/${cur.appId}.json`; }
      if (status === "FAILED") next.errorMessage = this.opts.errorMessage ?? "Scrape failed. Try again.";
      this.set(id, next);
    }, this.opts.stepMs * n);
  }

  private scheduleAnalytics(id: string, n: number, status: AnalyticsStatus) {
    setTimeout(() => {
      const cur = this.rows.get(id); if (!cur) return;
      const next: Job = { ...cur, analyticsStatus: status };
      if (status === "SUCCEEDED") { next.analyticsJson = ANALYTICS_JSON; next.analyticsErrorMessage = null; }
      if (status === "FAILED") next.analyticsErrorMessage = "Analytics failed.";
      this.set(id, next);
    }, this.opts.stepMs * n);
  }

  private set(id: string, row: Job) { this.rows.set(id, row); (this.listeners.get(id) ?? []).forEach((l) => l([row])); }
}
