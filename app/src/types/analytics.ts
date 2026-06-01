export interface SentimentBucket { period: string; avgCompound: number; reviewCount: number; }
export interface Keyword { term: string; count: number; }
export interface HelpfulReview {
  text: string; votesUp: number; votesFunny: number; votedUp: boolean;
  createdAt: number; language: string; playtimeForeverHours: number | null;
}
export interface AnalyticsPayload {
  hasData: boolean;
  coversFullHistory: boolean;
  totalAnalyzed: number;
  englishReviewCount: number;
  sentiment: { weekly: SentimentBucket[]; analyzedAvgCompound: number | null };
  words: {
    overallAdjectives: Keyword[]; overallPhrases: Keyword[];
    praiseAdjectives: Keyword[]; praisePhrases: Keyword[];
    complaintAdjectives: Keyword[]; complaintPhrases: Keyword[];
  };
  helpful: { positive: HelpfulReview[]; negative: HelpfulReview[] };
}

/** Tolerant: never throws; returns null on null/parse-error/non-object/shape-miss (spec §5).
 *  Validates the NESTED structure (not just hasData) so a partial payload can't crash a
 *  component that reads e.g. `analytics.sentiment.weekly` without optional chaining. */
export function parseAnalytics(json: string | null | undefined): AnalyticsPayload | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    if (!p || typeof p !== "object" || typeof p.hasData !== "boolean") return null;
    const s = p.sentiment as Record<string, unknown> | undefined;
    const w = p.words as Record<string, unknown> | undefined;
    const h = p.helpful as Record<string, unknown> | undefined;
    if (!s || !Array.isArray(s.weekly)) return null;
    if (!w || !Array.isArray(w.overallAdjectives) || !Array.isArray(w.overallPhrases)
          || !Array.isArray(w.praiseAdjectives) || !Array.isArray(w.praisePhrases)
          || !Array.isArray(w.complaintAdjectives) || !Array.isArray(w.complaintPhrases)) return null;
    if (!h || !Array.isArray(h.positive) || !Array.isArray(h.negative)) return null;
    return p as unknown as AnalyticsPayload;
  } catch {
    return null;
  }
}
