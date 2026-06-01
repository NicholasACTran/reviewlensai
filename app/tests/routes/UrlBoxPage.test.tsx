import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { server } from "../../src/test/mswServer";
import { http, HttpResponse } from "msw";
import { UrlBoxPage } from "../../src/routes/UrlBoxPage";

const V = "https://validator.example/";

function renderPage(onNavigate = vi.fn()) {
  render(<MemoryRouter><UrlBoxPage validatorUrl={V} onSubmitted={onNavigate} /></MemoryRouter>);
}

describe("UrlBoxPage", () => {
  it("shows the inline error on a 4xx", async () => {
    server.use(http.post(V, () => HttpResponse.json({ error: "That's not a Steam game URL." }, { status: 400 })));
    renderPage();
    await userEvent.type(screen.getByRole("textbox"), "nope");
    await userEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That's not a Steam game URL.");
  });
  it("calls onSubmitted(jobId) on success", async () => {
    server.use(http.post(V, () => HttpResponse.json({ jobId: "job-9" })));
    const onSub = vi.fn();
    renderPage(onSub);
    await userEvent.type(screen.getByRole("textbox"), "https://store.steampowered.com/app/1/");
    await userEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await vi.waitFor(() => expect(onSub).toHaveBeenCalledWith("job-9"));
  });
});
