import type { Job } from "../types/job";
import type { JobClient, Observable } from "./jobClient";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ModelsLike = { Job: { observeQuery: (opts: { filter: { id: { eq: string } } }) => { subscribe: (cb: (snap: { items: any[] }) => void) => { unsubscribe(): void } } } };
/* eslint-enable @typescript-eslint/no-explicit-any */

export class AmplifyJobClient implements JobClient {
  constructor(private models: ModelsLike) {}
  observeJob(id: string): Observable<Job[]> {
    return {
      subscribe: (next) => {
        const sub = this.models.Job.observeQuery({ filter: { id: { eq: id } } })
          .subscribe((snap) => next(snap.items.map(normalize)));
        return { unsubscribe: () => sub.unsubscribe() };
      },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalize(r: any): Job {
  return {
    id: r.id, status: r.status, steamUrl: r.steamUrl, appId: r.appId,
    gameName: r.gameName ?? null, headerImage: r.headerImage ?? null, price: r.price ?? null,
    totalReviews: r.totalReviews ?? null, pctPositive: r.pctPositive ?? null,
    scrapedReviews: r.scrapedReviews ?? null, s3Key: r.s3Key ?? null, errorMessage: r.errorMessage ?? null,
    analyticsStatus: r.analyticsStatus ?? null, analyticsErrorMessage: r.analyticsErrorMessage ?? null,
    analyticsJson: r.analyticsJson ?? null,
  };
}
