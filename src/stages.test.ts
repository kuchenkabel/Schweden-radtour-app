import { describe, expect, it } from "vitest";
import { cumulativeKm, type LonLat } from "./geo";
import { PoiIndex, poisAlongRoute } from "./pois";
import { planStages, toDayPlan } from "./stages";

// Gerade Route nach Norden, ca. 300 km, Punkte alle ~1 km
const line: LonLat[] = [];
for (let i = 0; i <= 300; i++) line.push([13.0, 55.5 + i / 111, 20]);
const cum = cumulativeKm(line);

function index(pois: [string, number][]) {
  // [Kategorie, km entlang]
  const cats = ["camping", "vindskydd", "badplats"];
  return new PoiIndex({
    cats,
    pois: pois.map(([c, km]) => [cats.indexOf(c), Math.round((55.5 + km / 111) * 1e5), 1300100, `${c}@${km}`]),
  });
}

describe("planStages", () => {
  it("teilt die Route in Etappen im 30-50-km-Fenster an Schlafplätzen", () => {
    const pts: [string, number][] = [];
    for (let km = 10; km < 300; km += 7) pts.push(["camping", km]);
    const idx = index(pts);
    const rp = poisAlongRoute(idx, line, 2, cum);
    const stages = planStages(line, cum, rp);
    expect(stages.length).toBeGreaterThanOrEqual(6);
    expect(stages.length).toBeLessThanOrEqual(10);
    for (const s of stages.slice(0, -1)) {
      expect(s.km).toBeGreaterThanOrEqual(28);
      expect(s.km).toBeLessThanOrEqual(52);
      expect(s.end?.cat).toBe("camping");
    }
    expect(stages[stages.length - 1].toKm).toBeCloseTo(cum[cum.length - 1], 1);
  });

  it("respektiert gepinnte Schlafplätze", () => {
    const pts: [string, number][] = [];
    for (let km = 10; km < 300; km += 7) pts.push(["camping", km]);
    const idx = index(pts);
    const rp = poisAlongRoute(idx, line, 2, cum);
    const pin = rp.find((r) => Math.abs(r.alongKm - 31) < 1)!.poi.id;
    const stages = planStages(line, cum, rp, undefined, [pin]);
    expect(stages.some((s) => s.end?.id === pin)).toBe(true);
  });

  it("setzt Mittagspause an eine Badestelle in der Etappenmitte", () => {
    const idx = index([["camping", 40], ["badplats", 22], ["camping", 80], ["badplats", 60]]);
    const short: LonLat[] = line.slice(0, 101);
    const c = cumulativeKm(short);
    const stages = planStages(short, c, poisAlongRoute(idx, short, 2, c));
    expect(stages[0].lunch?.name).toBe("badplats@22");
  });

  it("fügt Ruhetage ein", () => {
    const fake = Array.from({ length: 9 }, (_, i) => ({ day: i + 1 }) as any);
    const days = toDayPlan(fake, 4);
    expect(days.filter((d) => d.type === "rest").length).toBe(2);
    expect(days[4].type).toBe("rest");
  });
});

describe("Zelt-Erlaubnis", () => {
  const cats = ["camping", "vindskydd", "badplats"];
  const line2 = line;
  const mk = (pts: [number, string | undefined][]) =>
    new PoiIndex({
      cats,
      pois: pts.map(([km, tent], i) => [0, Math.round((55.5 + km / 111) * 1e5), 1300100, `C${i}@${km}`, tent ? { tent } : {}]),
    });

  it("Plätze mit tents=no werden nie Etappenende", () => {
    const pts: [number, string | undefined][] = [];
    for (let km = 10; km < 300; km += 7) pts.push([km, km % 2 ? "no" : "yes"]);
    const idx = mk(pts);
    const stages = planStages(line2, cum, poisAlongRoute(idx, line2, 2, cum));
    for (const s of stages.slice(0, -1)) expect(s.end?.x.tent).toBe("yes");
  });

  it("Ruhetag auf Platz ohne Angabe bekommt Hinweis", () => {
    const end = { id: 1, cat: "camping", lon: 0, lat: 0, name: "X", x: {} } as any;
    const st = Array.from({ length: 5 }, (_, i) => ({ day: i + 1, end, warnings: [] }) as any);
    const days = toDayPlan(st, 2);
    const w = days.find((d) => d.type === "ride" && d.stage!.day === 2)!.stage!.warnings;
    expect(w.some((x) => x.includes("anfragen"))).toBe(true);
  });
});
