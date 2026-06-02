export interface RawReview {
  recommendationid: string; language: string; review: string;
  votes_up: number; voted_up: boolean; timestamp_created: number;
}
export interface KbDoc { id: string; text: string; metadata: { jobId: string } }

export function buildKbDocs(jobId: string, reviews: RawReview[]): KbDoc[] {
  return reviews
    .filter((r) => r.language === "english" && r.review?.trim())
    .map((r) => ({
      id: `${jobId}#${r.recommendationid}`,
      text: r.review.trim(),
      metadata: { jobId },
    }));
}
