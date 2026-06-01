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
it("maps week-53 / week-1 across a year boundary into the correct month (both Thursdays land in 2022-01)", () => {
  // 2021-W53 Thursday = 2022-01-06; 2022-W01 Thursday = 2022-01-06 — both belong to 2022-01.
  const weekly = [
    { period: "2021-W53", avgCompound: 0.5, reviewCount: 10 },
    { period: "2022-W01", avgCompound: 0.2, reviewCount: 5 },
  ];
  const m = toMonthly(weekly);
  expect(m.length).toBe(1);
  expect(m[0].period).toBe("2022-01");
  expect(m[0].reviewCount).toBe(15);
  expect(m[0].avgCompound).toBeCloseTo((0.5 * 10 + 0.2 * 5) / 15, 4);
});

it("empty -> empty", () => { expect(toMonthly([])).toEqual([]); });
