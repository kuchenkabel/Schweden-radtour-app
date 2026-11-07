import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { bearingDeg, haversineKm, type LonLat } from "./geo";
import { getJson } from "./http";
import { REGIONS, type Region } from "./regions";
import { load, save } from "./store";

/** Eignungskarten (Wildcamping) pro Region, GitHub-Release data-latest. */
export const EIGNUNG_BASE = "https://github.com/kuchenkabel/schweden-radtour-app/releases/download/data-latest";
export const eignungUrl = (id: string) => `${EIGNUNG_BASE}/eignung-${id}.bin`;
export const eignungPath = (id: string) => `eignung/${id}.bin`;

export interface GridHeader {
  v: number;
  w: number;
  n: number;
  dlon: number;
  dlat: number;
  nx: number;
  ny: number;
  cell: number;
}
export interface Grid {
  header: GridHeader;
  data: Uint16Array;
}

export async function decodeGrid(buf: ArrayBuffer): Promise<Grid> {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "EIG1") {
    throw new Error("Ungültige Eignungsdatei");
  }
  const L = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + L))) as GridHeader;
  const body = bytes.slice(8 + L);
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = await new Response(stream).arrayBuffer();
  const n = header.nx * header.ny;
  if (raw.byteLength < n * 2) throw new Error("Eignungsdatei unvollständig");
  const data = new Uint16Array(n);
  const dv = new DataView(raw);
  for (let i = 0; i < n; i++) data[i] = dv.getUint16(i * 2, true);
  // Version 1 kannte keine Wiese: Untergrund 6 war Acker, jetzt 5 (Moor oder Acker)
  if ((header.v ?? 1) < 2) for (let i = 0; i < n; i++) if ((data[i] & 7) === 6) data[i] = (data[i] & ~7) | 5;
  return { header, data };
}

/** Zeile/Spalte der Zelle, die den Punkt enthält (oder null außerhalb). */
export function cellIndex(grid: Grid, lon: number, lat: number): { i: number; j: number } | null {
  const h = grid.header;
  const j = Math.floor((lon - h.w) / h.dlon);
  const i = Math.floor((h.n - lat) / h.dlat);
  if (i < 0 || j < 0 || i >= h.ny || j >= h.nx) return null;
  return { i, j };
}

export function cellAt(grid: Grid, lon: number, lat: number): number | null {
  const c = cellIndex(grid, lon, lat);
  return c ? grid.data[c.i * grid.header.nx + c.j] : null;
}

export const GROUND = ["Wasser/keine Daten", "Kiefernwald", "Nadel-/Mischwald", "Laubwald", "offenes Gras/Heide", "Moor, Sumpf oder Acker", "Wiese", "bebaut/Fels/Kahlschlag"];
/** Untergrund-Code für Wiesen (OSM landuse=meadow): geeignet nur, wenn gemäht und ungenutzt. */
export const MEADOW = 6;
export const MEADOW_HINT = "⚠️ Wiese: nur wenn gemäht und ungenutzt (kein Zaun, keine Heuballen), im Zweifel beim Hof fragen";
export const HOUSE_RANGE = ["< 50 m", "50–100 m", "100–150 m", "150–200 m", "200–300 m", "300–500 m", "500–1000 m", "> 1 km"];
export const SLOPE_RANGE = ["< 3°", "3–6°", "6–10°", "> 10°"];
export const WAY_RANGE = ["< 25 m", "25–120 m", "120–300 m", "kein Weg < 300 m"];
export const WATER_RANGE = ["< 30 m", "30–150 m", "150–400 m", "kein Wasser in der Nähe"];

export interface Cell {
  ground: number;
  house: number;
  slope: number;
  way: number;
  water: number;
  reserve: boolean;
  excluded: boolean;
  bigRoad: boolean;
  suitable: boolean;
}

export function decodeCell(v: number): Cell {
  return {
    ground: v & 7,
    house: (v >> 3) & 7,
    slope: (v >> 6) & 3,
    way: (v >> 8) & 3,
    water: (v >> 10) & 3,
    reserve: !!(v & 0x1000),
    excluded: !!(v & 0x2000),
    bigRoad: !!(v & 0x4000),
    suitable: !!(v & 0x8000),
  };
}

export function cellScore(c: Cell): number {
  const house = c.house === 4 ? 0.25 : c.house === 5 ? 0.6 : c.house >= 6 ? 1 : 0;
  const slope = c.slope === 0 ? 1 : c.slope === 1 ? 0.5 : 0;
  const water = c.water === 1 ? 1 : c.water === 2 ? 0.5 : 0;
  const way = c.way === 1 ? 1 : c.way === 2 ? 0.6 : 0;
  const ground = c.ground === 1 ? 1 : c.ground === 2 ? 0.8 : c.ground === 3 ? 0.75 : c.ground === 4 ? 0.5 : c.ground === MEADOW ? 0.4 : 0;
  return Math.round(35 * house + 20 * slope + 15 * water + 15 * way + 15 * ground - (c.reserve ? 10 : 0));
}

export function failReasons(c: Cell): string[] {
  const r: string[] = [];
  if (c.ground === 0) r.push("Wasser/keine Daten");
  if (c.ground === 5) r.push("Moor, Sumpf oder Acker – nicht zelten");
  if (c.ground === 7) r.push("bebaut, Fels oder Kahlschlag");
  if (c.house < 4) r.push(`Haus nur ${HOUSE_RANGE[c.house]} entfernt (Jedermannsrecht: außer Sichtweite, Faustregel ≥ 150–200 m)`);
  if (c.slope >= 2) r.push("Hang über 6°");
  if (c.way === 0) r.push("direkt an Weg/Straße");
  if (c.way === 3) r.push("kein Weg innerhalb 300 m");
  if (c.water === 0) r.push("zu nah am Ufer");
  if (c.bigRoad) r.push("große Straße < 150 m");
  if (c.excluded) r.push("Acker/Moor/Wohngebiet in < 30 m");
  if (!c.suitable && r.length === 0) r.push("Nicht alle Regeln erfüllt");
  return r;
}

/** Kurze Beschreibung einer geeigneten Stelle. */
export function spotReasons(c: Cell): string[] {
  const r = [
    `Untergrund: ${GROUND[c.ground]}`,
    `Haus ${HOUSE_RANGE[c.house]}`,
    `Neigung ${SLOPE_RANGE[c.slope]}`,
    c.way === 3 ? "kein Weg < 300 m" : `Weg ${WAY_RANGE[c.way]}`,
    c.water === 3 ? "kein Wasser in der Nähe" : `Wasser ${WATER_RANGE[c.water]}`,
  ];
  if (c.ground === MEADOW) r.push(MEADOW_HINT);
  if (c.reserve) r.push("⚠️ Schutzgebiet");
  return r;
}

export interface Spot {
  lon: number;
  lat: number;
  score: number;
  distM: number;
  bearing: number;
  cell: Cell;
  reasons: string[];
}
export interface ScanResult {
  here: { cell: Cell | null; suitable: boolean; reasons: string[] };
  spots: Spot[];
  suitableCount: number;
  landCount: number;
}

export function compass(deg: number): string {
  return ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export function scan(grid: Grid, center: LonLat, radiusM: number, maxSpots = 5, minSpacingM = 150): ScanResult {
  const h = grid.header;
  const kmLat = 110.574, kmLon = 111.32 * Math.cos((center[1] * Math.PI) / 180);
  const dLat = radiusM / 1000 / kmLat, dLon = radiusM / 1000 / kmLon;
  const i0 = Math.max(0, Math.floor((h.n - (center[1] + dLat)) / h.dlat));
  const i1 = Math.min(h.ny - 1, Math.floor((h.n - (center[1] - dLat)) / h.dlat));
  const j0 = Math.max(0, Math.floor((center[0] - dLon - h.w) / h.dlon));
  const j1 = Math.min(h.nx - 1, Math.floor((center[0] + dLon - h.w) / h.dlon));
  let landCount = 0, suitableCount = 0;
  const cands: Spot[] = [];
  for (let i = i0; i <= i1; i++) {
    const lat = h.n - (i + 0.5) * h.dlat;
    for (let j = j0; j <= j1; j++) {
      const lon = h.w + (j + 0.5) * h.dlon;
      const distM = haversineKm(center, [lon, lat]) * 1000;
      if (distM > radiusM) continue;
      const c = decodeCell(grid.data[i * h.nx + j]);
      if (c.ground === 0) continue;
      landCount++;
      if (!c.suitable) continue;
      suitableCount++;
      cands.push({ lon, lat, score: cellScore(c), distM, bearing: bearingDeg(center, [lon, lat]), cell: c, reasons: spotReasons(c) });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.distM - b.distM);
  const spots: Spot[] = [];
  for (const c of cands) {
    if (spots.length >= maxSpots) break;
    if (spots.every((s) => haversineKm([s.lon, s.lat], [c.lon, c.lat]) * 1000 >= minSpacingM)) spots.push(c);
  }
  const v = cellAt(grid, center[0], center[1]);
  const hc = v === null ? null : decodeCell(v);
  const here = {
    cell: hc,
    suitable: !!hc?.suitable,
    reasons: hc ? (hc.suitable ? [] : failReasons(hc)) : ["Keine Daten für diesen Punkt"],
  };
  return { here, spots, suitableCount, landCount };
}

/** Testgebiete außerhalb Schwedens (z.B. Deutschland, "als ob Jedermannsrecht gälte"),
 * gebaut von .github/workflows/camp-test.yml, Liste in data-latest/eignung-tests.json. */
let testRegions: Region[] = [];

export async function loadTestRegions(): Promise<void> {
  testRegions = await load<Region[]>("eignungTests", []);
  try {
    const list = await getJson(`${EIGNUNG_BASE}/eignung-tests.json`);
    if (Array.isArray(list)) {
      testRegions = list.map((r: any) => ({ id: String(r.id), name: String(r.name), bbox: r.bbox, hint: "Testgebiet" }));
      await save("eignungTests", testRegions);
    }
  } catch { /* offline oder keine Testgebiete: zwischengespeicherte Liste */ }
}

const allRegions = () => [...REGIONS, ...testRegions];

export function regionFor(lon: number, lat: number): Region | null {
  return allRegions().find((r) => lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3]) ?? null;
}

// ---------- Laden / Speichern ----------
const cache = new Map<string, Grid>();

function remember(id: string, g: Grid) {
  cache.delete(id);
  cache.set(id, g);
  while (cache.size > 2) cache.delete(cache.keys().next().value as string);
}

async function readLocal(id: string): Promise<ArrayBuffer | null> {
  try {
    const stat = await Filesystem.stat({ path: eignungPath(id), directory: Directory.Data });
    const res = await fetch(Capacitor.convertFileSrc(stat.uri));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export async function downloadEignung(id: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { await Filesystem.mkdir({ path: "eignung", directory: Directory.Data, recursive: true }); } catch { /* existiert schon */ }
  await Filesystem.downloadFile({ url: eignungUrl(id), path: eignungPath(id), directory: Directory.Data, recursive: true });
}

export async function deleteEignung(id: string): Promise<void> {
  cache.delete(id);
  try { await Filesystem.deleteFile({ path: eignungPath(id), directory: Directory.Data }); } catch { /* schon weg */ }
}

export async function loadGrid(regionId: string): Promise<Grid> {
  const hit = cache.get(regionId);
  if (hit) { remember(regionId, hit); return hit; }
  const name = allRegions().find((r) => r.id === regionId)?.name ?? regionId;
  const fail = () => new Error(`Eignungskarte für ${name} nicht verfügbar – einmal mit Internet öffnen`);
  try {
    let buf: ArrayBuffer | null = null;
    if (Capacitor.isNativePlatform()) {
      buf = await readLocal(regionId);
      if (!buf) {
        await downloadEignung(regionId);
        buf = await readLocal(regionId);
      }
    } else {
      const res = await fetch(eignungUrl(regionId));
      if (!res.ok) throw new Error(String(res.status));
      buf = await res.arrayBuffer();
    }
    if (!buf) throw new Error("leer");
    const grid = await decodeGrid(buf);
    remember(regionId, grid);
    return grid;
  } catch {
    throw fail();
  }
}
