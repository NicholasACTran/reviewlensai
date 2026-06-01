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
