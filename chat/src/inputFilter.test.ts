import { preFilter } from "./inputFilter";

test("high non-ASCII ratio (non-Latin script) -> NON_ENGLISH", () => {
  expect(preFilter("这些评论里最常见的抱怨是什么？").refusal).toBe("NON_ENGLISH");
});

test("plain English passes and is unchanged", () => {
  const r = preFilter("What are the most common complaints?");
  expect(r.refusal).toBeUndefined();
  expect(r.prompt).toBe("What are the most common complaints?");
});

test("strips HTML/script while keeping the question (no refusal)", () => {
  const r = preFilter("<script>alert(1)</script> what are the complaints?");
  expect(r.refusal).toBeUndefined();
  expect(r.prompt).not.toMatch(/<script>|<\/script>|alert\(/);
  expect(r.prompt).toMatch(/what are the complaints/);
});

test("keeps common chat punctuation (no over-sanitization)", () => {
  const r = preFilter("What's the #1 issue — is it 90% crashes?");
  expect(r.refusal).toBeUndefined();
  expect(r.prompt).toContain("#1");
  expect(r.prompt).toContain("90%");
  expect(r.prompt).toContain("?");        // common punctuation kept
  expect(r.prompt).not.toContain("—");    // em-dash is non-ASCII -> stripped by the allowlist
});

test("over-length is silently truncated, not refused", () => {
  const r = preFilter("A".repeat(5000) + " complaints?");
  expect(r.refusal).toBeUndefined();
  expect(r.prompt.length).toBeLessThanOrEqual(2000);
});

test("repetition flood is collapsed, not refused", () => {
  const r = preFilter(("spam ").repeat(200) + "complaints?");
  expect(r.refusal).toBeUndefined();
  expect(r.prompt.length).toBeLessThan(200);
});
