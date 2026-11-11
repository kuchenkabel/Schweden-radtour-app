import { climb, indexAtKm, steepSections, type LonLat, type SteepSection } from "./geo";
import { CAT_INFO, type Poi, type RoutePoi } from "./pois";

export interface StageSettings {
  minKm: number;
  maxKm: number;
  targetKm: number;
  /** Nach so vielen Fahrtagen ein Ruhetag (0 = keine Ruhetage) */
  restAfter: number;
  /** Verfügbare Tage gesamt (inkl. Ruhetage) */
  days: number;
  /** Höhenmeter, die einem zusätzlichen Kilometer entsprechen (Anhänger + Kind: 50) */
  hmPerKm: number;
  /** Maximaler Abstand eines Schlafplatzes von der Route in km */
  sleepCorridorKm: number;
  /** Warnung ab so vielen Höhenmetern bergauf pro Etappe */
  maxUp: number;
  /** Warnung bei Anstiegen ab dieser Steigung in % */
  steepPct: number;
}

export const DEFAULT_SETTINGS: StageSettings = {
  minKm: 30,
  maxKm: 50,
  targetKm: 40,
  restAfter: 4,
  days: 21,
  hmPerKm: 50,
  sleepCorridorKm: 3,
  maxUp: 400,
  steepPct: 6,
};

export interface Stage {
  day: number;
  fromKm: number;
  toKm: number;
  km: number;
  up: number;
  down: number;
  /** km + Höhenmeter-Zuschlag */
  effKm: number;
  end: Poi | null;
  endOffKm: number;
  lunch: Poi | null;
  /** Steile Anstiege in dieser Etappe (km ab Routenstart) */
  steep: SteepSection[];
  warnings: string[];
}

export interface DayPlan {
  type: "ride" | "rest";
  stage?: Stage;
  day: number;
}

import { SLEEP_PENALTY } from "./sleep";

interface Node { km: number; poi: Poi | null; off: number }

/**
 * Teilt eine Route in Tagesetappen, die jeweils an einem Schlafplatz enden.
 * Dynamische Programmierung über alle Schlafplatz-Kandidaten entlang der Route.
 * `pinned`: POI-IDs, die als Etappenende gesetzt sein müssen (manuell verschoben).
 */
export function planStages(
  line: LonLat[],
  cum: number[],
  routePois: RoutePoi[],
  settings: StageSettings = DEFAULT_SETTINGS,
  pinned: number[] = [],
  /** Zusätzlicher Zuschlag je Schlafplatz (z. B. Wassernähe), kleiner = besser */
  extra: (p: Poi) => number = () => 0,
): Stage[] {
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [];
  const sleepers = routePois.filter(
    (r) => CAT_INFO[r.poi.cat].sleep && r.offKm <= settings.sleepCorridorKm && r.alongKm > 1 && r.alongKm < total - 1,
  );
  const nodes: Node[] = [{ km: 0, poi: null, off: 0 }];
  for (const r of sleepers) nodes.push({ km: r.alongKm, poi: r.poi, off: r.offKm });
  nodes.push({ km: total, poi: null, off: 0 });
  nodes.sort((a, b) => a.km - b.km);

  const pinnedSet = new Set(pinned);
  const isPinned = (n: Node) => !!n.poi && pinnedSet.has(n.poi.id);

  // Höhenmeter-Präfixsummen für schnelle Etappen-Steigung
  const upPrefix = new Float64Array(line.length);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1][2], b = line[i][2];
    const d = a !== undefined && b !== undefined ? Math.max(0, b - a) : 0;
    upPrefix[i] = upPrefix[i - 1] + d;
  }
  const upBetween = (fromKm: number, toKm: number) =>
    (upPrefix[indexAtKm(cum, toKm)] - upPrefix[indexAtKm(cum, fromKm)]) * 0.7; // 0,7: Rauschen grob herausrechnen

  const S = settings;
  const edgeCost = (a: Node, b: Node): number => {
    const km = b.km - a.km + b.off; // Umweg zum Schlafplatz zählt mit
    const eff = km + upBetween(a.km, b.km) / S.hmPerKm;
    let c = ((eff - S.targetKm) / 5) ** 2;
    if (eff > S.maxKm) c += ((eff - S.maxKm) / 2) ** 2 * 10;
    const isLast = b.poi === null;
    if (eff < S.minKm && !isLast) c += ((S.minKm - eff) / 3) ** 2 * 4;
    if (b.poi) c += (SLEEP_PENALTY[b.poi.cat] ?? 5) + (b.poi.cat === "vindskydd" && !b.poi.x?.ver ? 1.5 : 0) + extra(b.poi);
    c += 4; // Grundkosten pro Tag: weniger Etappen bevorzugt, wenn sonst gleich
    return c;
  };

  // DP mit Fenster: nur Kanten bis maxKm * 1.6, damit O(n * k)
  const n = nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  best[0] = 0;
  const window = S.maxKm * 1.6;
  for (let j = 1; j < n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (nodes[j].km - nodes[i].km > window) break;
      if (best[i] === Infinity) continue;
      // Kein gepinnter Knoten darf übersprungen werden
      let skipsPinned = false;
      for (let k = i + 1; k < j; k++) if (isPinned(nodes[k])) { skipsPinned = true; break; }
      if (skipsPinned) continue;
      const c = best[i] + edgeCost(nodes[i], nodes[j]);
      if (c < best[j]) { best[j] = c; prev[j] = i; }
    }
    // Lücke ohne Schlafplatz im Fenster: notfalls direkt von der nächsten erreichbaren Stelle
    if (best[j] === Infinity) {
      for (let i = j - 1; i >= 0; i--) {
        if (best[i] < Infinity) { best[j] = best[i] + edgeCost(nodes[i], nodes[j]) + 100; prev[j] = i; break; }
      }
    }
  }

  const path: number[] = [];
  for (let j = n - 1; j >= 0; j = prev[j]) {
    path.push(j);
    if (j === 0) break;
  }
  path.reverse();

  const allSteep = steepSections(line, cum, settings.steepPct ?? 6);
  const lunchCands = routePois.filter((r) => r.poi.cat === "badplats" && r.offKm <= 1.5);
  const stages: Stage[] = [];
  for (let s = 1; s < path.length; s++) {
    const a = nodes[path[s - 1]], b = nodes[path[s]];
    const iFrom = indexAtKm(cum, a.km), iTo = indexAtKm(cum, b.km);
    const { up, down } = climb(line, iFrom, iTo);
    const km = b.km - a.km + b.off;
    const effKm = km + up / S.hmPerKm;
    // Mittagspause: Badestelle möglichst nahe 55 % der Etappe
    const ideal = a.km + (b.km - a.km) * 0.55;
    let lunch: Poi | null = null, lunchD = Infinity;
    for (const r of lunchCands) {
      if (r.alongKm < a.km + (b.km - a.km) * 0.3 || r.alongKm > a.km + (b.km - a.km) * 0.8) continue;
      const d = Math.abs(r.alongKm - ideal) + r.offKm * 2;
      if (d < lunchD) { lunchD = d; lunch = r.poi; }
    }
    const warnings: string[] = [];
    if (effKm > S.maxKm) warnings.push(`Lang: ${Math.round(effKm)} km inkl. Höhenmeter`);
    const maxUp = S.maxUp ?? 400;
    if (up > maxUp) warnings.push(`${up} Höhenmeter (mehr als ${maxUp})`);
    const steep = allSteep.filter((x) => x.toKm > a.km && x.fromKm < b.km);
    for (const x of steep.slice(0, 3))
      warnings.push(`Steil bei km ${Math.round(x.fromKm - a.km)}: bis ${String(x.maxPct).replace(".", ",")} % auf ${Math.max(100, Math.round((x.toKm - x.fromKm) * 1000 / 50) * 50)} m (${x.gainM} Hm)`);
    if (steep.length > 3) warnings.push(`… und ${steep.length - 3} weitere steile Stellen`);
    if (!b.poi && s < path.length - 1) warnings.push("Kein Schlafplatz gefunden");
    if (b.off > 1.5) warnings.push(`Schlafplatz ${b.off.toFixed(1)} km abseits`);
    stages.push({
      day: s, fromKm: a.km, toKm: b.km, km, up, down, effKm, end: b.poi, endOffKm: b.off, lunch, steep, warnings,
    });
  }
  return stages;
}

/** Fügt Ruhetage ein und nummeriert die Tage. */
export function toDayPlan(stages: Stage[], restAfter: number): DayPlan[] {
  const REST_OK = new Set(["camping", "stf", "hostel", "huette"]);
  const out: DayPlan[] = [];
  let day = 1, ridden = 0;
  stages.forEach((stage, i) => {
    const restNext = restAfter > 0 && ridden + 1 === restAfter && i < stages.length - 1;
    const warnings = restNext && stage.end && !REST_OK.has(stage.end.cat)
      ? [...stage.warnings, "Ruhetag folgt: besser ein Campingplatz mit Duschen und Waschmaschine"]
      : stage.warnings;
    out.push({ type: "ride", stage: { ...stage, day, warnings }, day });
    day++;
    ridden++;
    if (restNext) {
      out.push({ type: "rest", day });
      day++;
      ridden = 0;
    }
  });
  return out;
}

/** Alternative Schlafplätze rund um ein Etappenende (für manuelles Verschieben). */
export function alternativesNear(routePois: RoutePoi[], km: number, rangeKm = 12, corridorKm = 3): RoutePoi[] {
  return routePois
    .filter((r) => CAT_INFO[r.poi.cat].sleep && r.offKm <= corridorKm && Math.abs(r.alongKm - km) <= rangeKm)
    .sort((a, b) => Math.abs(a.alongKm - km) - Math.abs(b.alongKm - km));
}
