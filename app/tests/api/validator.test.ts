import { describe, it, expect } from "vitest";
import { submitUrl } from "../../src/api/validator";
import { server } from "../../src/test/mswServer";
import { http, HttpResponse } from "msw";

const URL = "https://validator.example/";

describe("submitUrl", () => {
  it("returns jobId on 200", async () => {
    server.use(http.post(URL, () => HttpResponse.json({ jobId: "abc" })));
    await expect(submitUrl(URL, "https://store.steampowered.com/app/1/")).resolves.toEqual({ ok: true, jobId: "abc" });
  });
  it("returns the error string on 4xx", async () => {
    server.use(http.post(URL, () => HttpResponse.json({ error: "That's not a Steam game URL." }, { status: 400 })));
    await expect(submitUrl(URL, "nope")).resolves.toEqual({ ok: false, error: "That's not a Steam game URL." });
  });
  it("maps network failure to a generic error", async () => {
    server.use(http.post(URL, () => HttpResponse.error()));
    const r = await submitUrl(URL, "x");
    expect(r).toEqual({ ok: false, error: "Something went wrong. Please try again." });
  });
});
