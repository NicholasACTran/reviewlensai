import { REFUSALS, RefusalCode } from "./refusals";

test("exactly the four closed codes exist with non-empty English strings", () => {
  const codes: RefusalCode[] = ["OFF_TOPIC", "NON_ENGLISH", "NO_DATA", "BLOCKED"];
  expect(Object.keys(REFUSALS).sort()).toEqual([...codes].sort());
  for (const c of codes) expect(REFUSALS[c].length).toBeGreaterThan(0);
});
