/** Geometrie-Hilfen. Koordinaten immer [lon, lat] bzw. [lon, lat, ele]. */
export type LonLat = [number, number] | [number, number, number];

const R = 6371.0088; // Erdradius in km

export function haversineKm(a: LonLat, b: LonLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Kumulierte Distanz in km für jeden Punkt der Linie. */
export function cumulativeKm(line: LonLat[]): number[] {
  const out = new Array<number>(line.length);
  let d = 0;
  out[0] = 0;
  for (let i = 1; i < line.length; i++) {
    d += haversineKm(line[i - 1], line[i]);
    out[i] = d;
  }
  return out;
}

/** Bearing (Fahrtrichtung) von a nach b in Grad, 0 = Nord, im Uhrzeigersinn. */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

export interface Projection {
  /** Distanz entlang der Linie in km */
  alongKm: number;
  /** Abstand des Punkts zur Linie in km */
  offKm: number;
  /** Index des Segmentanfangs */
  seg: number;
}

/**
 * Projiziert einen Punkt auf die Linie (lokal eben genähert, für Abstände bis einige km genau genug).
 * `from`/`to` begrenzen die Suche auf einen Segmentbereich (schneller bei bekannter Position).
 */
export function projectOnLine(
  p: LonLat,
  line: LonLat[],
  cum: number[],
  from = 0,
  to = line.length - 1,
): Projection {
  let best: Projection = { alongKm: 0, offKm: Infinity, seg: 0 };
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110.574;
  for (let i = Math.max(0, from); i < Math.min(to, line.length - 1); i++) {
    const a = line[i], b = line[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const off = Math.sqrt(cx * cx + cy * cy);
    if (off < best.offKm) {
      best = { alongKm: cum[i] + t * (cum[i + 1] - cum[i]), offKm: off, seg: i };
    }
  }
  return best;
}

/** Index des ersten Punkts mit cum >= km (binäre Suche). */
export function indexAtKm(cum: number[], km: number): number {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < km) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Punkt auf der Linie bei Distanz km (interpoliert). */
export function pointAtKm(line: LonLat[], cum: number[], km: number): LonLat {
  const i = indexAtKm(cum, km);
  if (i === 0) return line[0];
  const a = line[i - 1], b = line[i];
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (km - cum[i - 1]) / seg : 0;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Auf- und Abstieg in Metern zwischen zwei Indizes, mit 5-m-Hysterese gegen GPS-Rauschen. */
export function climb(line: LonLat[], from: number, to: number): { up: number; down: number } {
  let up = 0, down = 0;
  let ref: number | undefined;
  for (let i = from; i <= to && i < line.length; i++) {
    const e = line[i][2];
    if (e === undefined || Number.isNaN(e)) continue;
    if (ref === undefined) { ref = e; continue; }
    const d = e - ref;
    if (d >= 5) { up += d; ref = e; }
    else if (d <= -5) { down -= d; ref = e; }
  }
  return { up: Math.round(up), down: Math.round(down) };
}

export function bboxOf(line: LonLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of line) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}
