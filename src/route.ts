import { getJson } from "./http";
import type { LonLat } from "./geo";

/** Fahrrad-Routing über den öffentlichen BRouter-Server (nur online, nur im Planungsmodus). */
export async function brouterRoute(waypoints: LonLat[], profile = "trekking"): Promise<LonLat[]> {
  if (waypoints.length < 2) throw new Error("Mindestens Start und Ziel nötig");
  const lonlats = waypoints.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|");
  const url = `https://brouter.de/brouter?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}&alternativeidx=0&format=geojson`;
  const gj = await getJson(url);
  const coords: number[][] = gj.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error("Keine Route gefunden");
  return coords.map((c) => (c.length > 2 ? [c[0], c[1], c[2]] : [c[0], c[1]]) as LonLat);
}

/** Liest Track- oder Routenpunkte aus einer GPX-Datei (Komoot, OsmAnd, Garmin …). */
export function parseGpx(xml: string): { name: string; line: LonLat[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Keine gültige GPX-Datei");
  let pts = Array.from(doc.getElementsByTagName("trkpt"));
  if (!pts.length) pts = Array.from(doc.getElementsByTagName("rtept"));
  if (!pts.length) throw new Error("GPX enthält keinen Track");
  const line: LonLat[] = pts.map((p) => {
    const lon = parseFloat(p.getAttribute("lon")!);
    const lat = parseFloat(p.getAttribute("lat")!);
    const ele = p.getElementsByTagName("ele")[0]?.textContent;
    return ele ? [lon, lat, parseFloat(ele)] : [lon, lat];
  });
  const name =
    doc.querySelector("trk > name")?.textContent ||
    doc.querySelector("metadata > name")?.textContent ||
    "Importierte Route";
  return { name: name.trim(), line: simplify(line, 0.005) };
}

/** Erzeugt GPX für OsmAnd/Organic Maps. */
export function toGpx(name: string, line: LonLat[]): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const pts = line
    .map((p) => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}">${p[2] !== undefined ? `<ele>${p[2].toFixed(1)}</ele>` : ""}</trkpt>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Schweden-Radtour-App" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${esc(name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>`;
}

/** Douglas-Peucker in km (lokal eben genähert); hält riesige GPX-Dateien klein. */
export function simplify(line: LonLat[], tolKm: number): LonLat[] {
  if (line.length < 3) return line;
  const kx = 111.32 * Math.cos((line[0][1] * Math.PI) / 180), ky = 110.574;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = line[a][0] * kx, ay = line[a][1] * ky;
    const dx = line[b][0] * kx - ax, dy = line[b][1] * ky - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((line[i][0] * kx - ax) * dy - (line[i][1] * ky - ay) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tolKm) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}
