import type { SentimentBucket } from "../types/analytics";

/** ISO week-year + week -> the Monday-based week's Thursday (ISO weeks are defined by Thursday). */
function isoWeekToDate(period: string): Date {
  const [y, w] = period.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;            // 0=Mon..6=Sun
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const thursday = new Date(week1Monday);
  thursday.setUTCDate(week1Monday.getUTCDate() + (w - 1) * 7 + 3);
  return thursday;
}

export function toMonthly(weekly: SentimentBucket[]): SentimentBucket[] {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const b of weekly) {
    const d = isoWeekToDate(b.period);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = acc.get(key) ?? { sum: 0, count: 0 };
    cur.sum += b.avgCompound * b.reviewCount;
    cur.count += b.reviewCount;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, { sum, count }]) => ({
      period, reviewCount: count, avgCompound: count ? Number((sum / count).toFixed(4)) : 0,
    }));
}
