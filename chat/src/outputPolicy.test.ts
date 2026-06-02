import { applyOutputPolicy } from "./outputPolicy";
import { REFUSALS } from "./refusals";

const ctx = { analyticsNumbers: new Set(["73"]), retrievedText: "users report crashes and bugs", sentinel: "SENTINEL_X" };

test("strips URLs/markdown links from output (boundary #4)", () => {
  const r = applyOutputPolicy("See http://evil.example and [x](http://e)", ctx);
  expect(r).not.toMatch(/http:\/\//);
  expect(r).not.toMatch(/\]\(/);
});

test(">20% non-ASCII output -> NON_ENGLISH refusal (#5)", () => {
  expect(applyOutputPolicy("这是中文回答这是中文回答这是中文", ctx)).toBe(REFUSALS.NON_ENGLISH);
});

test("system-prompt sentinel in output -> BLOCKED (#7/#10)", () => {
  expect(applyOutputPolicy("...the secret is SENTINEL_X...", ctx)).toBe(REFUSALS.BLOCKED);
});

test("PII anonymization tokens are stripped to [redacted] (#11)", () => {
  expect(applyOutputPolicy("contact {EMAIL} or {PHONE}", ctx)).toContain("[redacted]");
});

test("a review-statistic number not in analytics -> NO_DATA (#8)", () => {
  expect(applyOutputPolicy("About 90% of reviews are positive.", ctx)).toBe(REFUSALS.NO_DATA);
});

test("a grounded statistic passes (#8)", () => {
  expect(applyOutputPolicy("Roughly 73% of reviews are positive.", ctx))
    .toBe("Roughly 73% of reviews are positive.");
});

test("non-statistic numbers are exempt (fail-open)", () => {
  const out = "Players mention the 2019 launch and chapter 3.";
  expect(applyOutputPolicy(out, ctx)).toBe(out);
});

test("a clean grounded answer passes through unchanged", () => {
  const out = "The most common complaints are crashes and bugs.";
  expect(applyOutputPolicy(out, ctx)).toBe(out);
});

test("a stat within rounding of an analytics number passes (#8 'within rounding')", () => {
  // ctx has analyticsNumbers {"73"}; 72.8 rounds to 73 -> grounded
  expect(applyOutputPolicy("Roughly 72.8% are positive.", ctx)).toBe("Roughly 72.8% are positive.");
});

test("a comma-grouped grounded count is not falsely refused", () => {
  const c = { analyticsNumbers: new Set(["1234"]), retrievedText: "", sentinel: "S" };
  expect(applyOutputPolicy("There are 1,234 reviews.", c)).toBe("There are 1,234 reviews.");
});
