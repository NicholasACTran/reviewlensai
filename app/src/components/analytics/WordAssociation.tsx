import { useState } from "react";
import type { AnalyticsPayload, Keyword } from "../../types/analytics";

type Lens = "overall" | "praise" | "complaint";

function Chips({ items }: { items: Keyword[] }) {
  if (items.length === 0) return <span className="chip-empty">—</span>;
  return (
    <ul className="chips">
      {items.map((k, i) => (
        <li key={`${k.term}-${i}`} className="chip">
          <span className="chip-term">{k.term}</span>
          <span className="chip-count">{k.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function WordAssociation({ words }: { words: AnalyticsPayload["words"] }) {
  const [lens, setLens] = useState<Lens>("overall");
  const adjectives = words[`${lens}Adjectives`];
  const phrases = words[`${lens}Phrases`];
  return (
    <div className="word-association">
      <h3>Word association</h3>
      <div className="toggle" role="group" aria-label="Keyword lens">
        <button aria-pressed={lens === "overall"} onClick={() => setLens("overall")}>Overall</button>
        <button aria-pressed={lens === "praise"} onClick={() => setLens("praise")}>Praise</button>
        <button aria-pressed={lens === "complaint"} onClick={() => setLens("complaint")}>Complaint</button>
      </div>
      <div className="word-group">
        <h4>Adjectives</h4>
        <Chips items={adjectives} />
      </div>
      <div className="word-group">
        <h4>Phrases</h4>
        <Chips items={phrases} />
      </div>
    </div>
  );
}
