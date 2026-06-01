import { useEffect, useRef, useState } from "react";
import type { JobClient } from "../api/jobClient";
import { toJobView, type Job, type JobView } from "../types/job";

const STALE_MS_DEFAULT = 12 * 60 * 1000; // spec §5.2: must exceed scraper 600s timeout + margin

export function useJob(client: JobClient, id: string, staleMs: number = STALE_MS_DEFAULT): JobView {
  const [view, setView] = useState<JobView>({ kind: "waiting" });
  const lastStatus = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const arm = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setView({ kind: "tryagain", message: "This is taking too long. Try again." }), staleMs);
    };
    arm();
    const sub = client.observeJob(id).subscribe((items: Job[]) => {
      if (items.length === 0) return;            // [] = still waiting, not "not found"
      const job = items[0];
      if (job.status !== lastStatus.current) { lastStatus.current = job.status; arm(); } // reset on real SCRAPE transition (analyticsStatus changes are not watch-dogged)
      const v = toJobView(job);
      // Terminal SCRAPE state stops the clock. The analytics lifecycle (analyticsStatus RUNNING→
      // SUCCEEDED) then runs un-timed: it's fast (seconds) and self-updates via the subscription, so
      // a stuck "Analyzing…" only occurs if the subscription itself drops — an accepted PoC gap.
      if (v.kind !== "waiting") { if (timer.current) clearTimeout(timer.current); }
      setView(v);
    });
    return () => { sub.unsubscribe(); if (timer.current) clearTimeout(timer.current); };
  }, [client, id, staleMs]);

  return view;
}
