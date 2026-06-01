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
      <SentimentChart data={a} />
      <div className="analytics-grid">
        <WordAssociation words={a.words} />
        <HelpfulReviews helpful={a.helpful} />
      </div>
    </section>
  );
}
