import type { Job, JobStatus } from "../types/job";
import type { JobClient, Observable } from "./jobClient";

interface FakeOpts { stepMs?: number; outcome?: "SUCCEEDED" | "FAILED"; errorMessage?: string; }
type Seed = Partial<Job> & { id: string; appId: string; steamUrl: string };

export class FakeJobClient implements JobClient {
  private rows = new Map<string, Job>();
  private listeners = new Map<string, ((items: Job[]) => void)[]>();
  private opts: Required<Pick<FakeOpts, "stepMs" | "outcome">> & Pick<FakeOpts, "errorMessage">;

  constructor(opts: FakeOpts = {}) {
    this.opts = { stepMs: opts.stepMs ?? 1200, outcome: opts.outcome ?? "SUCCEEDED", errorMessage: opts.errorMessage };
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

  private set(id: string, row: Job) { this.rows.set(id, row); (this.listeners.get(id) ?? []).forEach((l) => l([row])); }
}
