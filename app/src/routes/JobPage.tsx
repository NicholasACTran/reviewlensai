import { useNavigate, useParams } from "react-router-dom";
import type { JobClient } from "../api/jobClient";
import { useJob } from "../hooks/useJob";
import { WaitingScreen } from "../components/WaitingScreen";
import { NominalScreen } from "../components/NominalScreen";
import { TryAgainScreen } from "../components/TryAgainScreen";

export function JobView(props: { client: JobClient; id: string }) {
  const navigate = useNavigate?.() ?? (() => {});
  const view = useJob(props.client, props.id);
  switch (view.kind) {
    case "waiting": return <WaitingScreen />;
    case "nominal": return <NominalScreen {...view} />;
    case "tryagain": return <TryAgainScreen message={view.message} onRetry={() => navigate("/")} />;
  }
}

export function JobPage(props: { client: JobClient }) {
  const { id } = useParams();
  if (!id) return <p>Missing job id.</p>;
  return <JobView client={props.client} id={id} />;
}
