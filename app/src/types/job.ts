export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** Mirror of the AppSync `Job` row (spec §3). Backend may send null for unset fields. */
export interface Job {
  id: string;
  status: JobStatus;
  steamUrl: string;
  appId: string;
  gameName: string | null;
  headerImage: string | null;
  price: string | null;
  totalReviews: number | null;
  pctPositive: number | null;
  scrapedReviews: number | null;
  s3Key: string | null;
  errorMessage: string | null;
}

export type JobView =
  | { kind: "waiting" }
  | { kind: "nominal"; gameName: string; headerImage: string | null; price: string | null;
      totalReviews: number; pctPositive: number | null }
  | { kind: "tryagain"; message: string };

const DEFAULT_FAIL = "Scrape failed. Try again.";

export function toJobView(job: Job): JobView {
  switch (job.status) {
    case "PENDING":
    case "RUNNING":
      return { kind: "waiting" };
    case "SUCCEEDED":
      return {
        kind: "nominal",
        gameName: job.gameName ?? "Unknown game",
        headerImage: job.headerImage,
        price: job.price,
        totalReviews: job.totalReviews ?? 0,
        pctPositive: job.pctPositive,
      };
    case "FAILED":
      return { kind: "tryagain", message: job.errorMessage ?? DEFAULT_FAIL };
  }
}
