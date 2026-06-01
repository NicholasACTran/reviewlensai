import { http, HttpResponse } from "msw";

/** Default local-sim handler; tests override per-case via server.use(). */
export const handlers = [
  http.post(/\/validate$|validator/i, async ({ request }) => {
    const body = (await request.json()) as { url?: string };
    if (!body.url || !/store\.steampowered\.com\/app\/\d+/.test(body.url)) {
      return HttpResponse.json({ error: "That's not a Steam game URL." }, { status: 400 });
    }
    return HttpResponse.json({ jobId: "local-" + Date.now() });
  }),
];
