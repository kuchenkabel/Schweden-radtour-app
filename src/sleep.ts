/**
 * Schlafplatz-Bewertung: Wassernähe (Badestelle/See) und Vorschläge für „heute Nacht“
 * nach Uhrzeit, bereits gefahrenen Kilometern und Ermüdung.
 */
import { CAT_INFO, type Poi, type PoiIndex } from "./pois";
import type { StageSettings } from "./stages";

/** Bevorzugung je Schlafplatz-Typ (kleiner = besser). */
export const SLEEP_PENALTY: Partial<Record<string, number>> = {
  camping: 0, lager: 1, vindskydd: 2, stf: 3, huette: 4, hostel: 6, zeltplatz: 5,
};

/** Kategorien, bei denen Wasser nicht verlangt wird (Campingplatz hat Dusche/Wasser, Hütten/Hostels sind Unterkünfte). */
const NO_WATER_NEEDED = new Set(["camping", "stf", "hostel", "huette"]);

/** Abstand zum nächsten Wasser in m; null = unbekannt, Infinity = keins in der Nähe. Ergebnis wird zwischengespeichert. */
const waterCache = new Map<number, number | null>();
export function waterDistM(p: Poi, index: PoiIndex | null): number | null {
  if (p.cat === "zeltplatz") {
    const w = Number(p.x.wa);
    return Number.isFinite(w) ? (w >= 9999 ? Infinity : w) : null;
  }
  if (!index) return null;
  if (waterCache.has(p.id)) return waterCache.get(p.id)!;
  const near = index.nearest([p.lon, p.lat], new Set(["badplats"]), 0.6, 1)[0];
  const r = near ? near.km * 1000 : null;
  waterCache.set(p.id, r);
  return r;
}

/** Zuschlag (+) oder Bonus (−) für die Lage am Wasser. */
export function waterPenalty(p: Poi, index: PoiIndex | null): number {
  if (NO_WATER_NEEDED.has(p.cat)) return 0;
  const w = waterDistM(p, index);
  if (w === null) return 1; // unbekannt: leichter Malus gegenüber geprüft-am-Wasser
  if (w <= 150) return -1.5;
  if (w <= 400) return -0.5;
  return 3;
}

/** Zuschlag/Bonus für Zeltplatz-Kandidaten nach Score (schöne, ruhige Stellen zuerst). */
export function qualityPenalty(p: Poi): number {
  if (p.cat !== "zeltplatz") return 0;
  const sc = Number(p.x.sc) || 60;
  return -Math.max(0, Math.min(2, (sc - 60) / 10));
}

/** Gesamtzuschlag für die Etappenplanung. */
export const sleepExtra = (index: PoiIndex | null) => (p: Poi) => waterPenalty(p, index) + qualityPenalty(p);

export function waterLabel(p: Poi, index: PoiIndex | null): string {
  if (NO_WATER_NEEDED.has(p.cat)) return "";
  const w = waterDistM(p, index);
  if (w === null) return "Wasser unbekannt";
  if (w === Infinity) return "kein Wasser in der Nähe";
  return `Wasser ${w < 100 ? "< 100" : Math.round(w / 50) * 50} m`;
}

export interface Fatigue {
  /** Aktuelle (ggf. simulierte) Uhrzeit */
  now: Date;
  /** Heute schon gefahrene km */
  kmToday: number;
}

export interface Budget {
  /** Wunschdistanz bis zum Schlafplatz (effektive km) */
  idealKm: number;
  /** Mehr sollte es nicht werden */
  limitKm: number;
  hint: string;
}

export const CAMP_HOUR = 15.5;
export const LATEST_HOUR = 18.5;
const SPEED = 10; // km/h inkl. kleiner Pausen, Familie mit Anhänger/Kindersitz

export function budgetFor(f: Fatigue, s: Pick<StageSettings, "targetKm" | "maxKm">): Budget {
  const h = f.now.getHours() + f.now.getMinutes() / 60;
  const tired = Math.min(0.3, f.kmToday / 150); // Tempo sinkt mit den Kilometern
  const v = SPEED * (1 - tired);
  const timeIdeal = Math.max(0, (CAMP_HOUR - h) * v);
  const timeHard = Math.max(0, (LATEST_HOUR - h) * v);
  const leftTarget = Math.max(0, s.targetKm - f.kmToday);
  const leftMax = Math.max(0, s.maxKm - f.kmToday);
  let ideal = Math.min(timeIdeal, leftTarget);
  let limit = Math.min(timeHard, leftMax);
  let hint = `Noch ca. ${Math.round(ideal)} km bis zur Camp-Zeit um 15:30 (${Math.round(f.kmToday)} km heute schon gefahren).`;
  if (ideal < 3) {
    ideal = 0;
    limit = Math.max(limit, 8);
    hint = h >= CAMP_HOUR || f.kmToday >= s.targetKm
      ? "Für heute ist es genug: nächsten brauchbaren Schlafplatz nehmen."
      : "Wenig Reserve: eher etwas Nahes wählen.";
  }
  return { idealKm: ideal, limitKm: Math.max(limit, ideal), hint };
}

export interface Candidate {
  poi: Poi;
  /** Weg bis dorthin in km (inkl. Umweg) */
  distKm: number;
  /** Höhenmeter bergauf auf dem Weg dorthin */
  up: number;
  offKm: number;
}

export interface Suggestion extends Candidate {
  effKm: number;
  score: number;
  water: string;
  note: string;
}

export function rankSleep(cands: Candidate[], b: Budget, index: PoiIndex | null, hmPerKm: number, max = 5): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of cands) {
    if (!CAT_INFO[c.poi.cat].sleep || c.distKm < 0.2) continue;
    const effKm = c.distKm + c.up / hmPerKm;
    if (effKm > b.limitKm + 8) continue;
    let score = ((effKm - b.idealKm) / 5) ** 2;
    if (effKm > b.limitKm) score += ((effKm - b.limitKm) / 2) ** 2 * 10;
    score += (SLEEP_PENALTY[c.poi.cat] ?? 5) + waterPenalty(c.poi, index) + qualityPenalty(c.poi) + c.offKm * 1.5;
    const note = effKm > b.limitKm ? "weiter als empfohlen" : effKm < b.idealKm - 8 && b.idealKm > 0 ? "früher Feierabend möglich" : "";
    out.push({ ...c, effKm, score, water: waterLabel(c.poi, index), note });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, max);
}
