import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./mswServer";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// jsdom lacks matchMedia (used by any animated waiting screen)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
});
