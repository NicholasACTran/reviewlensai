export function WaitingScreen() {
  return (
    <div className="waiting" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>Analyzing reviews…</p>
    </div>
  );
}
