import type { Job } from "../types/job";

export interface Subscription { unsubscribe(): void; }
export interface Observable<T> { subscribe(next: (value: T) => void): Subscription; }

/** Mirrors Amplify Data observeQuery on a single id: emits an items array (len 0|1). */
export interface JobClient {
  observeJob(id: string): Observable<Job[]>;
}
