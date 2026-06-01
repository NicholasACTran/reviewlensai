export function TryAgainScreen(props: { message: string; onRetry: () => void }) {
  return (
    <div className="tryagain" role="alert">
      <p>{props.message}</p>
      <button onClick={props.onRetry}>Try again</button>
    </div>
  );
}
