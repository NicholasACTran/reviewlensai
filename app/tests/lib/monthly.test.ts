import { it, expect } from "vitest";
import { toMonthly } from "../../src/lib/monthly";

it("aggregates weekly ISO buckets into count-weighted monthly buckets", () => {
  const weekly = [
    { period: "2024-W02", avgCompound: 0.4, reviewCount: 10 },
    { period: "2024-W03", avgCompound: 0.6, reviewCount: 30 },
    { period: "2024-W06", avgCompound: -0.2, reviewCount: 5 },
  ];
  const m = toMonthly(weekly);
  const jan = m.find((b) => b.period === "2024-01")!;
  expect(jan.reviewCount).toBe(40);
  expect(jan.avgCompound).toBeCloseTo((0.4 * 10 + 0.6 * 30) / 40, 4);
  expect(m.find((b) => b.period === "2024-02")!.reviewCount).toBe(5);
  expect(m).toEqual([...m].sort((a, b) => a.period.localeCompare(b.period)));
});
it("empty -> empty", () => { expect(toMonthly([])).toEqual([]); });
