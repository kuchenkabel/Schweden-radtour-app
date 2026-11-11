/**
 * Bearbeitbare Route aus Abschnitten ("Legs") zwischen Wegpunkten, wie bei Komoot:
 * Punkte verschieben, auf der Linie einfügen, löschen. Neu berechnet wird nur, was sich ändert.
 *
 * Ein Abschnitt ist entweder geroutet (BRouter, darf neu berechnet werden) oder fest
 * (z.B. aus einer GPX-Datei). Ein fester Abschnitt wird nie komplett neu berechnet: Ändert
 * sich ein Punkt daneben, wird nur ein Stück von ANCHOR_KM neu geroutet, der Rest bleibt.
 */
import { cumulativeKm, indexAtKm, projectOnLine, type LonLat } from "./geo";

export const ANCHOR_KM = 3;

/** Abschnitt: Linie (inkl. beider Endpunkte) oder null = muss neu berechnet werden. */
export interface Leg {
  line: LonLat[] | null;
  fixed: boolean;
}

export interface Editable {
  waypoints: LonLat[];
  legs: Leg[];
}

const same = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** Gesamtlinie und Index jedes Wegpunkts in der Linie (cuts). Abschnitte ohne Linie werden übersprungen. */
export function assemble(e: Editable): { line: LonLat[]; cuts: number[]; fixed: boolean[] } {
  const line: LonLat[] = [];
  const cuts: number[] = [0];
  for (const leg of e.legs) {
    const l = leg.line ?? [];
    if (l.length) {
      if (line.length && same(line[line.length - 1], l[0])) line.push(...l.slice(1));
      else line.push(...l);
    }
    cuts.push(Math.max(0, line.length - 1));
  }
  return { line, cuts, fixed: e.legs.map((l) => l.fixed) };
}

/**
 * Baut die Abschnitte aus einem gespeicherten Plan auf. Fehlen `cuts`/`fixed` (ältere Pläne),
 * werden die Wegpunkte auf die Linie projiziert und alle Abschnitte als fest betrachtet,
 * damit keine vorhandene Strecke ungefragt verändert wird.
 */
export function fromPlan(waypoints: LonLat[], line: LonLat[], cuts?: number[], fixed?: boolean[]): Editable {
  const wps = waypoints.slice();
  if (wps.length < 2) return { waypoints: wps, legs: [] };
  if (line.length < 2) return { waypoints: wps, legs: wps.slice(1).map(() => ({ line: null, fixed: false })) };
  let c = cuts;
  const valid =
    Array.isArray(c) && c.length === wps.length && c[0] === 0 && c[c.length - 1] === line.length - 1 &&
    c.every((v, i) => Number.isInteger(v) && (i === 0 || v >= c![i - 1]));
  if (!valid) {
    const cum = cumulativeKm(line);
    c = [0];
    let from = 0;
    for (let i = 1; i < wps.length - 1; i++) {
      const pr = projectOnLine(wps[i], line, cum, from);
      const idx = Math.max(from, pr.seg + (pr.alongKm - cum[pr.seg] > (cum[pr.seg + 1] - cum[pr.seg]) / 2 ? 1 : 0));
      c.push(idx);
      from = idx;
    }
    c.push(line.length - 1);
  }
  const fx = Array.isArray(fixed) && fixed.length === wps.length - 1 && valid ? fixed : wps.slice(1).map(() => true);
  const legs: Leg[] = [];
  for (let i = 0; i < wps.length - 1; i++) legs.push({ line: line.slice(c![i], c![i + 1] + 1), fixed: !!fx[i] });
  return { waypoints: wps, legs };
}

function clone(e: Editable): Editable {
  return { waypoints: e.waypoints.slice(), legs: e.legs.map((l) => ({ ...l })) };
}

/** Punkt am Ende anhängen (Punkte-setzen-Modus). */
export function appendPoint(e: Editable, p: LonLat): Editable {
  const r = clone(e);
  r.waypoints.push(p);
  if (r.waypoints.length >= 2) r.legs.push({ line: null, fixed: false });
  return r;
}

/** In welchem Abschnitt liegt der Punkt (nächster Punkt der Linie) und wo darin? */
export function locate(e: Editable, p: LonLat): { leg: number; km: number; offKm: number } | null {
  let best: { leg: number; km: number; offKm: number } | null = null;
  e.legs.forEach((leg, i) => {
    if (!leg.line || leg.line.length < 2) return;
    const cum = cumulativeKm(leg.line);
    const pr = projectOnLine(p, leg.line, cum);
    if (!best || pr.offKm < best.offKm) best = { leg: i, km: pr.alongKm, offKm: pr.offKm };
  });
  return best;
}

/** Teilt einen festen Abschnitt bei km; gibt [vorher, nachher] mit dem Teilungspunkt an beiden Enden zurück. */
function splitAt(line: LonLat[], km: number): [LonLat[], LonLat[]] {
  const cum = cumulativeKm(line);
  const i = Math.min(Math.max(1, indexAtKm(cum, km)), line.length - 1);
  return [line.slice(0, i + 1), line.slice(i)];
}

/**
 * Neuen Zwischenpunkt einfügen. `at` = Stelle auf der Route, die angefasst wurde (bestimmt den
 * Abschnitt), `p` = wohin der Punkt gezogen wurde (Standard: dieselbe Stelle).
 */
export function insertPoint(e: Editable, at: LonLat, p: LonLat = at): Editable {
  const loc = locate(e, at);
  if (!loc) return appendPoint(e, p);
  const r = clone(e);
  const i = loc.leg;
  const leg = r.legs[i];
  if (!leg.fixed || !leg.line) {
    r.waypoints.splice(i + 1, 0, p);
    r.legs.splice(i, 1, { line: null, fixed: false }, { line: null, fixed: false });
    return r;
  }
  // Fester Abschnitt: nur ±ANCHOR_KM um die Stelle neu routen
  const total = cumulativeKm(leg.line)[leg.line.length - 1];
  const aKm = loc.km - ANCHOR_KM, bKm = loc.km + ANCHOR_KM;
  const newWps: LonLat[] = [];
  const newLegs: Leg[] = [];
  let rest = leg.line;
  let restStart = 0;
  if (aKm > 0.5) {
    const [before, after] = splitAt(rest, aKm);
    newLegs.push({ line: before, fixed: true });
    newWps.push(before[before.length - 1]);
    rest = after;
    restStart = aKm;
  }
  newLegs.push({ line: null, fixed: false });
  newWps.push(p);
  if (bKm < total - 0.5) {
    const [, after] = splitAt(rest, bKm - restStart);
    newLegs.push({ line: null, fixed: false });
    newWps.push(after[0]);
    newLegs.push({ line: after, fixed: true });
  } else {
    newLegs.push({ line: null, fixed: false });
  }
  r.waypoints.splice(i + 1, 0, ...newWps);
  r.legs.splice(i, 1, ...newLegs);
  return r;
}

/** Wegpunkt verschieben; angrenzende geroutete Abschnitte werden neu berechnet, feste nur nahe am Punkt. */
export function movePoint(e: Editable, idx: number, p: LonLat): Editable {
  const r = clone(e);
  r.waypoints[idx] = p;
  // Abschnitt danach zuerst (Indizes davor bleiben gültig)
  if (idx < r.legs.length) {
    const leg = r.legs[idx];
    const total = leg.line && leg.line.length > 1 ? cumulativeKm(leg.line)[leg.line.length - 1] : 0;
    if (leg.fixed && leg.line && total > ANCHOR_KM + 0.5) {
      const [, after] = splitAt(leg.line, ANCHOR_KM);
      r.legs.splice(idx, 1, { line: null, fixed: false }, { line: after, fixed: true });
      r.waypoints.splice(idx + 1, 0, after[0]);
    } else {
      r.legs[idx] = { line: null, fixed: false };
    }
  }
  if (idx > 0) {
    const li = idx - 1;
    const leg = r.legs[li];
    const total = leg.line && leg.line.length > 1 ? cumulativeKm(leg.line)[leg.line.length - 1] : 0;
    if (leg.fixed && leg.line && total > ANCHOR_KM + 0.5) {
      const [before] = splitAt(leg.line, total - ANCHOR_KM);
      r.legs.splice(li, 1, { line: before, fixed: true }, { line: null, fixed: false });
      r.waypoints.splice(idx, 0, before[before.length - 1]);
    } else {
      r.legs[li] = { line: null, fixed: false };
    }
  }
  return r;
}

/** Wegpunkt löschen. Zwei geroutete Nachbarn werden zu einem neu berechneten Abschnitt; sonst bleibt die Strecke. */
export function removePoint(e: Editable, idx: number): Editable {
  const r = clone(e);
  if (r.waypoints.length <= 2) {
    r.waypoints.splice(idx, 1);
    r.legs = [];
    return r;
  }
  if (idx === 0) { r.waypoints.shift(); r.legs.shift(); return r; }
  if (idx === r.waypoints.length - 1) { r.waypoints.pop(); r.legs.pop(); return r; }
  const a = r.legs[idx - 1], b = r.legs[idx];
  let merged: Leg;
  if (!a.fixed && !b.fixed) merged = { line: null, fixed: false };
  else if (a.line && b.line) merged = { line: [...a.line, ...b.line.slice(1)], fixed: true };
  else merged = { line: null, fixed: false };
  r.waypoints.splice(idx, 1);
  r.legs.splice(idx - 1, 2, merged);
  return r;
}

/** Alle gerouteten Abschnitte zur Neuberechnung markieren (z.B. nach Profilwechsel). */
export function markRoutedDirty(e: Editable): Editable {
  const r = clone(e);
  r.legs = r.legs.map((l) => (l.fixed ? l : { line: null, fixed: false }));
  return r;
}

/** Indizes der Abschnitte, die neu berechnet werden müssen. */
export const pendingLegs = (e: Editable) => e.legs.map((l, i) => (l.line ? -1 : i)).filter((i) => i >= 0);
