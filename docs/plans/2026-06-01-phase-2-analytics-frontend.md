# Phase 2 Analytics Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the analytics dashboard on the job page — the `AnalyticsPayload` contract type + tolerant parser, the analytics-status state gating, and the grid-layout dashboard (sentiment chart + volume, praise/complaint keywords, helpful reviews) — exercisable locally via the FakeAmplifyClient with a shared fixture.

**Architecture:** App-domain (React+Vite) change. `AnalyticsPayload` TS interface mirrors the worker's `payload.py` keys (the shared canonical fixture from PR 3a enforces no drift). The nominal `JobView` is extended to carry `analyticsStatus` + parsed `analytics`; a new `AnalyticsSection` component gates on status and renders the layout-B grid (chart full-width; keywords beside helpful reviews). Recharts for the one dual-axis time series; monthly view derived FE-side from the weekly buckets.

**Tech Stack:** React, Vite, TypeScript, Recharts (new dep), vitest (run via `node node_modules/vitest/vitest.mjs run`; OneDrive blocks `.bin`). The existing app tests pass without `pool: 'forks'`; if vitest hangs on Windows, add `test: { pool: 'forks' }` to `vite.config.ts` (don't assume it's already set).

**Spec:** `docs/specs/2026-06-01-phase-2-analytics-design.md` §5 (payload), §10 (FE states + grid layout), §14.3 (weekly stored, monthly derived).

**Prerequisites:** PR 2-A deployed (schema fields live; FE on Amplify 1.23). PR 3a merged (the shared canonical fixture `analytics/tests/fixtures/analytics_payload.example.json` exists — this plan copies it into the app test tree so both domains satisfy the same contract).

**Deploy:** via the existing `app-deploy.yml` (app domain). Can develop+merge independently of the analytics backend (renders fake data); true E2E once 3a+3b are deployed.

---

## File Structure

- **Create** `app/src/types/analytics.ts` — `AnalyticsPayload` interface + `parseAnalytics`.
- **Modify** `app/src/types/job.ts` — add 3 fields to `Job`; extend `toJobView` nominal with analytics status + parsed payload.
- **Modify** `app/src/api/amplifyJobClient.ts` — `normalize` maps the 3 new fields.
- **Modify** `app/src/api/fakeJobClient.ts` — simulate the `analyticsStatus` lifecycle with the fixture.
- **Create** `app/src/components/analytics/AnalyticsSection.tsx` — status gating + grid layout.
- **Create** `app/src/components/analytics/SentimentChart.tsx` — Recharts line+volume, weekly/monthly toggle.
- **Create** `app/src/components/analytics/WordAssociation.tsx` — praise/complaint + overall toggle.
- **Create** `app/src/components/analytics/HelpfulReviews.tsx` — pos/neg cards.
- **Create** `app/src/lib/monthly.ts` — derive monthly buckets from weekly (ISO-week → month).
- **Modify** `app/src/components/NominalScreen.tsx` — render `<AnalyticsSection>` below the scrape summary.
- **Test fixtures/tests** under `app/tests/...`.

---

## Task 1: Contract type + tolerant parser (TDD)

**Files:** `app/src/types/analytics.ts`, `app/tests/types/analytics.test.ts`, plus copy the shared fixture.

- [ ] **Step 1: Branch + HARD fixture precondition + add Recharts + copy the shared fixture**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" && git switch main && git pull --ff-only \
  && test -f analytics/tests/fixtures/analytics_payload.example.json \
     || { echo "STOP: shared fixture absent — PR 3a (which commits analytics/tests/fixtures/analytics_payload.example.json) must be merged to main first."; exit 1; } \
  && git switch -c phase2/analytics-frontend \
  && (cd app && npm install recharts) \
  && mkdir -p app/tests/fixtures && cp analytics/tests/fixtures/analytics_payload.example.json app/tests/fixtures/
```
Expected: the `test -f` passes (3a merged) and the fixture is copied. If it fails, STOP — this plan depends on PR 3a's canonical fixture.

- [ ] **Step 2: Failing tests**
```ts
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
    expect(parseAnalytics(JSON.stringify({ nope: 1 }))).toBeNull();  // missing hasData
  });
  it("the shared fixture has the exact contract shape (cross-domain drift guard)", () => {
    expect(new Set(Object.keys(fixture))).toEqual(new Set([
      "hasData","coversFullHistory","totalAnalyzed","englishReviewCount","sentiment","words","helpful"]));
    expect(new Set(Object.keys(fixture.words))).toEqual(new Set([
      "overallAdjectives","overallPhrases","praiseAdjectives","praisePhrases","complaintAdjectives","complaintPhrases"]));
  });
});
```

- [ ] **Step 3: Implement `analytics.ts`** (mirrors spec §5 / worker `payload.py`)
```ts
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
    if (!w || !Array.isArray(w.overallAdjectives) || !Array.isArray(w.praiseAdjectives)
          || !Array.isArray(w.complaintAdjectives)) return null;
    if (!h || !Array.isArray(h.positive) || !Array.isArray(h.negative)) return null;
    return p as unknown as AnalyticsPayload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run → pass; typecheck; commit**
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/app" \
  && node node_modules/vitest/vitest.mjs run analytics.test && node node_modules/typescript/bin/tsc --noEmit
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai" \
  && git add app/src/types/analytics.ts app/tests/types/analytics.test.ts app/tests/fixtures app/package.json app/package-lock.json \
  && git commit -m "feat(app): AnalyticsPayload type + tolerant parseAnalytics + shared fixture"
```
(Ensure `resolveJsonModule` is on in tsconfig for the fixture import — Vite enables it by default; add it if tsc complains.)

---

## Task 2: Extend `Job` + `toJobView` with analytics state (TDD)

**Files:** `app/src/types/job.ts`, `app/tests/types/job.test.ts`, `app/src/api/amplifyJobClient.ts`

- [ ] **Step 1: Failing tests** (add to `job.test.ts`)
```ts
import { toJobView } from "../../src/types/job";
const base = { id: "j", steamUrl: "u", appId: "1", gameName: "G", headerImage: null, price: null,
  totalReviews: 10, pctPositive: 0.9, scrapedReviews: 10, s3Key: "k", errorMessage: null,
  analyticsErrorMessage: null, analyticsJson: null };

it("nominal view carries analyticsStatus + parsed analytics", () => {
  const v = toJobView({ ...base, status: "SUCCEEDED", analyticsStatus: "RUNNING" } as any);
  expect(v.kind).toBe("nominal");
  if (v.kind === "nominal") { expect(v.analyticsStatus).toBe("RUNNING"); expect(v.analytics).toBeNull(); }
});
it("parses analyticsJson when SUCCEEDED", () => {
  const json = JSON.stringify({ hasData: true, coversFullHistory: true, totalAnalyzed: 1, englishReviewCount: 1,
    sentiment: { weekly: [], analyzedAvgCompound: 0 }, words: { overallAdjectives: [], overallPhrases: [],
    praiseAdjectives: [], praisePhrases: [], complaintAdjectives: [], complaintPhrases: [] },
    helpful: { positive: [], negative: [] } });
  const v = toJobView({ ...base, status: "SUCCEEDED", analyticsStatus: "SUCCEEDED", analyticsJson: json } as any);
  if (v.kind === "nominal") expect(v.analytics?.hasData).toBe(true);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — in `job.ts`:
  - Add to `Job`: `analyticsStatus: AnalyticsStatus | null; analyticsErrorMessage: string | null; analyticsJson: string | null;` and `export type AnalyticsStatus = "RUNNING" | "SUCCEEDED" | "FAILED";`
  - Extend the `nominal` variant of `JobView` with: `analyticsStatus: AnalyticsStatus | null; analyticsErrorMessage: string | null; analytics: AnalyticsPayload | null;`
  - In `toJobView`'s `SUCCEEDED` case, add: `analyticsStatus: job.analyticsStatus ?? null, analyticsErrorMessage: job.analyticsErrorMessage ?? null, analytics: parseAnalytics(job.analyticsJson),` (import `parseAnalytics`).
  - In `amplifyJobClient.ts` `normalize`, add: `analyticsStatus: r.analyticsStatus ?? null, analyticsErrorMessage: r.analyticsErrorMessage ?? null, analyticsJson: r.analyticsJson ?? null,`.

- [ ] **Step 3b: Fix every existing `Job`-typed literal (compile fan-out)** — adding 3 **required** fields to `Job` breaks every existing object typed `Job`. Find them and add `analyticsStatus: null, analyticsErrorMessage: null, analyticsJson: null`:
```bash
cd "C:/Users/nicho/OneDrive/Documents/Projects/reviewlensai/app" && grep -rn ": Job\b\|as Job\b" src tests
```
Known site: `app/tests/types/job.test.ts:4` (`const base: Job = {...}` — add the 3 fields). Check `app/tests/api/amplifyJobClient.test.ts` and `app/tests/api/fakeJobClient.test.ts` for `Job` literals/`normalize` expectations and patch any. (Task 5 separately extends the FakeJobClient row defaults.)

- [ ] **Step 4: Run → pass; typecheck (`node node_modules/typescript/bin/tsc --noEmit` — exhaustiveness + all Job literals); commit** (`feat(app): thread analytics status + parsed payload into JobView`).

---

## Task 3: `monthly.ts` — derive monthly buckets from weekly (TDD)

**Files:** `app/src/lib/monthly.ts`, `app/tests/lib/monthly.test.ts`

Monthly is derived FE-side (spec §14.3): map each ISO-week bucket to its month (via the week's Thursday, the ISO-defining day), then count-weighted-average the compounds.

- [ ] **Step 1: Failing tests**
```ts
import { toMonthly } from "../../src/lib/monthly";

it("aggregates weekly ISO buckets into count-weighted monthly buckets", () => {
  // 2024-W02 (early Jan) and 2024-W03 both fall in 2024-01
  const weekly = [
    { period: "2024-W02", avgCompound: 0.4, reviewCount: 10 },
    { period: "2024-W03", avgCompound: 0.6, reviewCount: 30 },
    { period: "2024-W06", avgCompound: -0.2, reviewCount: 5 },   // early Feb
  ];
  const m = toMonthly(weekly);
  const jan = m.find((b) => b.period === "2024-01")!;
  expect(jan.reviewCount).toBe(40);
  expect(jan.avgCompound).toBeCloseTo((0.4 * 10 + 0.6 * 30) / 40, 4); // 0.55
  expect(m.find((b) => b.period === "2024-02")!.reviewCount).toBe(5);
  expect(m).toEqual([...m].sort((a, b) => a.period.localeCompare(b.period)));
});
it("empty -> empty", () => { expect(toMonthly([])).toEqual([]); });
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `monthly.ts`**
```ts
import type { SentimentBucket } from "../types/analytics";

/** ISO week-year + week -> the Monday-based week's Thursday (ISO weeks are defined by Thursday). */
function isoWeekToDate(period: string): Date {
  const [y, w] = period.split("-W").map(Number);
  // Jan 4th is always in ISO week 1; find that week's Monday, then offset.
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
```

- [ ] **Step 4: Run → pass; commit** (`feat(app): derive monthly sentiment buckets from weekly`).

---

## Task 4: Dashboard components (grid layout B)

**Files:** `app/src/components/analytics/{AnalyticsSection,SentimentChart,WordAssociation,HelpfulReviews}.tsx` + tests.

- [ ] **Step 1: `AnalyticsSection.tsx` — status gating (spec §10) + grid**
```tsx
import type { AnalyticsStatus } from "../../types/job";
import type { AnalyticsPayload } from "../../types/analytics";
import { SentimentChart } from "./SentimentChart";
import { WordAssociation } from "./WordAssociation";
import { HelpfulReviews } from "./HelpfulReviews";

export function AnalyticsSection(props: {
  status: AnalyticsStatus | null; errorMessage: string | null; analytics: AnalyticsPayload | null;
}) {
  if (props.status == null) return null;                       // not started (lost event etc.) — no section
  if (props.status === "RUNNING") return <p className="analytics-loading">Analyzing reviews…</p>;
  if (props.status === "FAILED") return <p className="analytics-unavailable">Analytics unavailable.</p>;
  const a = props.analytics;
  if (!a || !a.hasData) return <p className="analytics-empty">Not enough reviews to analyze.</p>;
  return (
    <section className="analytics">
      <SentimentChart data={a} />                               {/* full-width top */}
      <div className="analytics-grid">                          {/* 2-col, collapses on mobile */}
        <WordAssociation words={a.words} />
        <HelpfulReviews helpful={a.helpful} />
      </div>
    </section>
  );
}
```
- [ ] **Step 2: `SentimentChart.tsx`** — Recharts `ComposedChart` (Line = avgCompound, Bar = reviewCount on a second Y axis), a `weekly|monthly` toggle (monthly via `toMonthly`), and a caption `Based on the most recent {totalAnalyzed} reviews` shown when `!coversFullHistory`. Empty `weekly` (sub-English-gate) → render `<p>Not enough English-language reviews for sentiment.</p>`.
```tsx
import { useState } from "react";
import { ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import type { AnalyticsPayload } from "../../types/analytics";
import { toMonthly } from "../../lib/monthly";

export function SentimentChart({ data }: { data: AnalyticsPayload }) {
  const [gran, setGran] = useState<"weekly" | "monthly">("weekly");
  if (data.sentiment.weekly.length === 0)
    return <p className="analytics-empty">Not enough English-language reviews for sentiment.</p>;
  const series = gran === "weekly" ? data.sentiment.weekly : toMonthly(data.sentiment.weekly);
  return (
    <div className="sentiment-chart">
      <div className="toggle" role="tablist">
        <button aria-pressed={gran === "weekly"} onClick={() => setGran("weekly")}>Weekly</button>
        <button aria-pressed={gran === "monthly"} onClick={() => setGran("monthly")}>Monthly</button>
      </div>
      {!data.coversFullHistory && (
        <p className="caption">Based on the most recent {data.totalAnalyzed.toLocaleString()} reviews</p>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={series}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="period" />
          <YAxis yAxisId="s" domain={[-1, 1]} />
          <YAxis yAxisId="v" orientation="right" allowDecimals={false} />
          <Tooltip />
          <Bar yAxisId="v" dataKey="reviewCount" fill="#9bc" opacity={0.4} />
          <Line yAxisId="s" type="monotone" dataKey="avgCompound" stroke="#1b66c9" dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
```
- [ ] **Step 3: `WordAssociation.tsx`** — an `overall|praise|complaint` toggle (default overall); render the adjective + phrase chip lists for the chosen lens (`overallAdjectives`/`Phrases`, etc.). Empty lists → "—".
- [ ] **Step 4: `HelpfulReviews.tsx`** — two columns (👍 positive / 👎 negative); each a card with truncated `text`, `▲ votesUp`, `😄 votesFunny`, `playtimeForeverHours` (if not null), and a `language` chip when `language !== "english"`.
- [ ] **Step 5: Component tests** (vitest + React Testing Library): `AnalyticsSection` renders nothing for `null`, "Analyzing…" for RUNNING, "unavailable" for FAILED, "Not enough reviews" for SUCCEEDED+`!hasData`, and the three children for SUCCEEDED+hasData (use the shared fixture). For `SentimentChart`, **do NOT assert the rendered SVG series length** (Recharts emits no stable, countable per-point DOM in jsdom even with `ResponsiveContainer` mocked). Instead assert testable seams: the `Based on the most recent N reviews` caption is present only when `!coversFullHistory`; clicking the Monthly button flips `aria-pressed` (Weekly→false, Monthly→true); and the English-gate empty state ("Not enough English-language reviews for sentiment") renders when `weekly` is `[]`. The weekly→monthly *aggregation* is already proven in Task 3's `toMonthly` unit tests — don't re-prove it through Recharts. (Mock `ResponsiveContainer` to a plain `<div>` so children render at all.)
- [ ] **Step 6: Run → pass; typecheck; commit** (`feat(app): analytics dashboard components (grid layout, Recharts chart)`).

---

## Task 5: Wire into NominalScreen + FakeJobClient analytics lifecycle

**Files:** `app/src/components/NominalScreen.tsx`, `app/src/api/fakeJobClient.ts`, tests.

- [ ] **Step 1: Render `<AnalyticsSection>` in `NominalScreen`** — `NominalScreen` currently takes scrape-summary props. Extend its props with `analyticsStatus`, `analyticsErrorMessage`, `analytics`, and render `<AnalyticsSection status={...} errorMessage={...} analytics={...} />` after the `<dl>`. **No change to `JobPage.tsx`** — it already does `return <NominalScreen {...view} />` (`JobPage.tsx:13`), so the spread propagates the new nominal fields automatically once NominalScreen's props are widened. Do NOT hand-edit that spread.

- [ ] **Step 2: FakeJobClient simulates the analytics lifecycle** — after the scrape `SUCCEEDED` step, schedule `analyticsStatus: "RUNNING"` then `"SUCCEEDED"` with `analyticsJson = JSON.stringify(<inline payload>)`. Add an `analyticsOutcome?: "SUCCEEDED" | "FAILED" | "none"` opt (default "SUCCEEDED"). In `schedule`, when status is the scrape outcome SUCCEEDED, chain two more timers writing `analyticsStatus`. **Use the inline payload constant below — `src/` must NOT import the `tests/` fixture** (production source stays self-contained; the fixture is test-only).
```ts
// in fakeJobClient.ts — after SUCCEEDED, drive analytics (inline minimal payload to keep src self-contained)
private scheduleAnalytics(id: string) {
  const json = JSON.stringify({ hasData: true, coversFullHistory: true, totalAnalyzed: 1234, englishReviewCount: 1100,
    sentiment: { weekly: [{ period: "2024-W02", avgCompound: 0.5, reviewCount: 800 },
                           { period: "2024-W03", avgCompound: 0.3, reviewCount: 434 }], analyzedAvgCompound: 0.42 },
    words: { overallAdjectives: [{ term: "gorgeous", count: 210 }], overallPhrases: [{ term: "boss fight", count: 90 }],
             praiseAdjectives: [{ term: "tight", count: 150 }], praisePhrases: [{ term: "hand drawn", count: 40 }],
             complaintAdjectives: [{ term: "brutal", count: 60 }], complaintPhrases: [{ term: "vague map", count: 20 }] },
    helpful: { positive: [{ text: "Best metroidvania.", votesUp: 312, votesFunny: 5, votedUp: true, createdAt: 1700000000, language: "english", playtimeForeverHours: 60 }],
               negative: [{ text: "DLC spike too hard.", votesUp: 88, votesFunny: 2, votedUp: false, createdAt: 1700000000, language: "english", playtimeForeverHours: 12 }] } });
  this.schedule2(id, 1, { analyticsStatus: "RUNNING" });
  this.schedule2(id, 2, { analyticsStatus: "SUCCEEDED", analyticsJson: json });
}
```
(Implement a small `schedule2(id, n, patch)` helper that merges a partial into the row on a timer, mirroring `schedule`. Call `scheduleAnalytics(id)` from `seed` when the scrape outcome is SUCCEEDED and `analyticsOutcome !== "none"`. Also extend the `Seed`/row defaults with the 3 nullable analytics fields so the fake row is type-complete.)

- [ ] **Step 3: Local visual check** — run the app against the fake client (`npm run dev`, or the existing fake-mode entrypoint) and confirm: waiting → nominal scrape summary → "Analyzing reviews…" → dashboard (chart + grid). Capture a screenshot to `screenshots/` (per project convention).

- [ ] **Step 4: Full suite + typecheck + lint; commit** (`feat(app): render AnalyticsSection in NominalScreen + fake analytics lifecycle`).

---

## Task 6: PR + (post 3a/3b) E2E

- [ ] **Step 1: Push, open PR, DA code review (CLAUDE.md 6.3), merge** → `app-deploy` ships the FE.
- [ ] **Step 2: E2E once 3a+3b are deployed** — run a real scrape, open the job page in a browser (Amplify URL from `/reviewlensai/amplify/url`), confirm the dashboard renders from the real `analyticsJson`. Watch DynamoDB `analyticsStatus` alongside the browser (per the validation-observability practice) to separate FE-render from backend timing. Screenshot to `screenshots/`.

---

## Definition of Done (maps to spec §5/§10/§14.3)

- [ ] `AnalyticsPayload` type mirrors §5 exactly; `parseAnalytics` tolerant (null on any bad input); shared fixture present + drift-guard test.
- [ ] `Job`/`toJobView` carry analytics status + parsed payload; `amplifyJobClient` maps the fields.
- [ ] Dashboard: status gating (null→none, RUNNING→loading, SUCCEEDED+hasData→grid, SUCCEEDED+!hasData→empty, FAILED→unavailable); sentiment chart (weekly/monthly toggle, volume bars, "most recent N" caption when `!coversFullHistory`, English-gate empty state); praise/complaint+overall keywords; helpful pos/neg cards.
- [ ] Monthly derived FE-side from weekly (ISO-week→month, count-weighted); tested incl. year boundary.
- [ ] FakeJobClient drives the analytics lifecycle; dashboard exercisable with no AWS; local screenshot captured.
- [ ] FE suite + typecheck + lint green; merged; E2E validated once backend is live.

---

## Self-Review notes
- **Contract single-source:** `analytics.ts` keys mirror the worker `payload.py`; the **shared fixture** (copied from PR 3a) is loaded by tests in BOTH domains, so a key rename fails a test on at least one side. This is the enforcement the worker plan's §5-fixture step set up.
- **State gating** distinguishes `null` (no section — lost-event job shows only the scrape result, per spec §9/§10) from `RUNNING` (spinner) — the round-1 "eternal spinner" fix. `useJob`'s staleness timer already stopped at the nominal/terminal scrape state, so analytics loading does not re-arm it.
- **Monthly from weekly** is the spec §14.3 decision; ISO-week→month via the week's Thursday is deterministic and tested at a year boundary. (A week straddling two months is attributed to its Thursday's month — acceptable for a trend view.)
- **`src` must not import from `tests`:** the FakeJobClient uses a small inline payload constant (not the test-tree fixture) so production source stays self-contained; the fixture is only imported by test files.
- **Recharts** is the one new dependency (spec §10 — the dual-axis toggleable chart is genuinely simpler than hand-rolled SVG; DA concurred).
