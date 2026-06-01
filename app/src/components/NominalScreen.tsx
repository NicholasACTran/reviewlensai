import type { AnalyticsStatus } from "../types/job";
import type { AnalyticsPayload } from "../types/analytics";
import { AnalyticsSection } from "./analytics/AnalyticsSection";

export function NominalScreen(props: {
  gameName: string; headerImage: string | null; price: string | null;
  totalReviews: number; pctPositive: number | null;
  analyticsStatus: AnalyticsStatus | null; analyticsErrorMessage: string | null;
  analytics: AnalyticsPayload | null;
}) {
  const pct = props.pctPositive == null ? "N/A" : `${Math.round(props.pctPositive * 100)}%`;
  return (
    <div className="nominal">
      {props.headerImage && <img src={props.headerImage} alt={props.gameName} />}
      <h1>{props.gameName}</h1>
      {props.price && <p className="price">{props.price}</p>}
      <dl>
        <div><dt>Reviews</dt><dd>{props.totalReviews.toLocaleString()}</dd></div>
        <div><dt>Positive</dt><dd>{pct}</dd></div>
      </dl>
      <AnalyticsSection
        status={props.analyticsStatus}
        errorMessage={props.analyticsErrorMessage}
        analytics={props.analytics}
      />
    </div>
  );
}
