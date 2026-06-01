export type SubmitResult = { ok: true; jobId: string } | { ok: false; error: string };

export async function submitUrl(validatorUrl: string, url: string): Promise<SubmitResult> {
  try {
    const res = await fetch(validatorUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
    });
    const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (res.ok && data.jobId) return { ok: true, jobId: data.jobId };
    return { ok: false, error: data.error ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
