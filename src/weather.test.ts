import { expect, it } from "vitest";
import { cumulativeKm, type LonLat } from "./geo";
import { feasibleKm, headwind } from "./weather";

const north: LonLat[] = [[13, 55], [13, 55.5]];
const cum = cumulativeKm(north);
it("Nordwind ist Gegenwind bei Fahrt nach Norden", () => {
  expect(headwind(north, cum, 0, cum[1], 0, 6)).toBeCloseTo(6, 1);
  expect(headwind(north, cum, 0, cum[1], 180, 6)).toBeCloseTo(-6, 1);
  expect(Math.abs(headwind(north, cum, 0, cum[1], 90, 6))).toBeLessThan(0.1);
});
it("schätzt machbare km", () => {
  expect(feasibleKm(40, 6)).toBe(28);
  expect(feasibleKm(40, 0)).toBe(40);
});
