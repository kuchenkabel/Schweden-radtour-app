import { describe, expect, it } from "vitest";
import { budgetFor, rankSleep, waterPenalty } from "./sleep";
import type { Poi } from "./pois";

const poi = (id: number, cat: Poi["cat"], x: Record<string, string> = {}): Poi => ({ id, cat, lon: 13, lat: 56, name: "n" + id, x });
const S = { targetKm: 40, maxKm: 50 };
const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

describe("Schlafplätze", () => {
  it("Wasser: Zeltplatz am See besser als ohne Wasser, Campingplatz neutral", () => {
    expect(waterPenalty(poi(1, "zeltplatz", { wa: "40" }), null)).toBeLessThan(0);
    expect(waterPenalty(poi(2, "zeltplatz", { wa: "9999" }), null)).toBeGreaterThan(0);
    expect(waterPenalty(poi(3, "camping"), null)).toBe(0);
  });
  it("Morgens volle Etappe, spät und müde: nah", () => {
    expect(budgetFor({ now: at(9), kmToday: 0 }, S).idealKm).toBeGreaterThan(35);
    const late = budgetFor({ now: at(16, 30), kmToday: 45 }, S);
    expect(late.idealKm).toBe(0);
    expect(late.limitKm).toBeLessThan(15);
  });
  it("Vorschlag nach Restkilometern, Wasserplatz gewinnt bei gleicher Entfernung", () => {
    const b = budgetFor({ now: at(13), kmToday: 25 }, S); // ~15 km Rest
    const r = rankSleep(
      [
        { poi: poi(1, "zeltplatz", { wa: "9999", sc: "70" }), distKm: 15, up: 0, offKm: 0 },
        { poi: poi(2, "zeltplatz", { wa: "30", sc: "70" }), distKm: 15, up: 0, offKm: 0 },
        { poi: poi(3, "vindskydd"), distKm: 45, up: 0, offKm: 0 },
      ],
      b, null, 50,
    );
    expect(r[0].poi.id).toBe(2);
    expect(r[r.length - 1].poi.id).not.toBe(2);
  });
});
