import { describe, expect, it } from "vitest";
import { cumulativeKm, type LonLat } from "./geo";
import { assemble, fromPlan, insertPoint, movePoint, pendingLegs, removePoint } from "./legs";

// Gerade Linie nach Norden, 20 km, Punkte alle ~100 m
const line: LonLat[] = [];
for (let i = 0; i <= 200; i++) line.push([13.0, 56.0 + i / 1110, 10 + i]);
const kmOf = (l: LonLat[]) => cumulativeKm(l)[l.length - 1];
const at = (km: number): LonLat => [13.0, 56.0 + (km * 10) / 1110];

describe("Abschnitte (Legs)", () => {
  it("importierte GPX: ein fester Abschnitt, Linie bleibt identisch", () => {
    const e = fromPlan([line[0], line[200]], line);
    expect(e.legs).toHaveLength(1);
    expect(e.legs[0].fixed).toBe(true);
    expect(assemble(e).line).toEqual(line);
  });

  it("Einfügen in festen Abschnitt routet nur ±3 km neu", () => {
    const e = insertPoint(fromPlan([line[0], line[200]], line), at(10), [13.01, 56.09]);
    // fest | neu | neu | fest
    expect(e.legs.map((l) => (l.line ? (l.fixed ? "F" : "R") : "-"))).toEqual(["F", "-", "-", "F"]);
    expect(e.waypoints).toHaveLength(5);
    expect(kmOf(e.legs[0].line!)).toBeCloseTo(7, 0);
    expect(kmOf(e.legs[3].line!)).toBeCloseTo(7, 0);
    expect(pendingLegs(e)).toEqual([1, 2]);
  });

  it("Einfügen nahe am Anfang legt keinen Anker vor dem Start an", () => {
    const e = insertPoint(fromPlan([line[0], line[200]], line), at(0.3));
    expect(e.legs.map((l) => (l.line ? "F" : "-"))).toEqual(["-", "-", "F"]);
    expect(e.waypoints[0]).toEqual(line[0]);
  });

  it("Verschieben des Ziels einer GPX-Route ändert nur die letzten 3 km", () => {
    const e = movePoint(fromPlan([line[0], line[200]], line), 1, [13.02, 56.19]);
    expect(e.legs.map((l) => (l.line ? "F" : "-"))).toEqual(["F", "-"]);
    expect(kmOf(e.legs[0].line!)).toBeCloseTo(17, 0);
    expect(e.waypoints[2]).toEqual([13.02, 56.19]);
  });

  it("geroutete Abschnitte werden beim Verschieben ganz neu berechnet", () => {
    const e0 = fromPlan([line[0], line[100], line[200]], line, [0, 100, 200], [false, false]);
    const e = movePoint(e0, 1, [13.01, 56.09]);
    expect(e.waypoints).toHaveLength(3);
    expect(pendingLegs(e)).toEqual([0, 1]);
  });

  it("Löschen: geroutete Nachbarn werden zusammen neu berechnet, feste bleiben", () => {
    const routed = removePoint(fromPlan([line[0], line[100], line[200]], line, [0, 100, 200], [false, false]), 1);
    expect(pendingLegs(routed)).toEqual([0]);
    const fixed = removePoint(fromPlan([line[0], line[100], line[200]], line, [0, 100, 200], [true, false]), 1);
    expect(pendingLegs(fixed)).toEqual([]);
    expect(assemble(fixed).line).toEqual(line);
  });

  it("alte Pläne ohne cuts: Wegpunkte werden auf die Linie projiziert", () => {
    const e = fromPlan([line[0], line[120], line[200]], line);
    expect(assemble(e).cuts).toEqual([0, 120, 200]);
  });
});

import { steepSections } from "./geo";
describe("Steile Anstiege", () => {
  it("findet eine 8-%-Rampe und ignoriert flache Strecken", () => {
    // 2 km flach, 500 m mit 8 %, 2 km flach (Punkte alle 50 m)
    const l: LonLat[] = [];
    let e = 10;
    for (let i = 0; i <= 90; i++) {
      const km = i * 0.05;
      if (km > 2 && km <= 2.5) e += 4;
      l.push([13.0, 56.0 + km / 111.2, e]);
    }
    const s = steepSections(l, cumulativeKm(l), 6);
    expect(s).toHaveLength(1);
    expect(s[0].maxPct).toBeGreaterThan(7);
    expect(s[0].fromKm).toBeGreaterThan(1.8);
    expect(s[0].toKm).toBeLessThan(2.7);
    expect(s[0].gainM).toBeGreaterThanOrEqual(30);
  });
});

import { profileText } from "./route";
describe("Familienprofil", () => {
  it("alle Platzhalter werden ersetzt", () => {
    for (const p of ["familie", "familie-flach", "familie-ruhig"] as const) expect(profileText(p)).not.toMatch(/\{\{/);
  });
});
