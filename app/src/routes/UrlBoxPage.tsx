import { useState } from "react";
import { submitUrl } from "../api/validator";

export function UrlBoxPage(props: { validatorUrl?: string; onSubmitted: (jobId: string) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!props.validatorUrl) return <p>App not yet configured. Check back shortly.</p>;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await submitUrl(props.validatorUrl!, url);
    setBusy(false);
    if (r.ok) props.onSubmitted(r.jobId); else setError(r.error);
  }

  return (
    <form onSubmit={onSubmit} className="urlbox">
      <h1>Review Lens AI</h1>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
        placeholder="https://store.steampowered.com/app/…" aria-label="Steam game URL" />
      <button type="submit" disabled={busy}>{busy ? "Analyzing…" : "Analyze"}</button>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}
