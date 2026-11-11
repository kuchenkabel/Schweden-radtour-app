import { getJson, postText } from "./http";
import type { LonLat } from "./geo";
import familieTemplate from "./brouter/familie.brf?raw";

/** Routing-Profile: eigenes Familienprofil (wird beim Server hochgeladen) oder BRouter-Standard. */
export type RouteProfile = "familie" | "familie-flach" | "familie-ruhig" | "trekking";

export const PROFILE_INFO: Record<RouteProfile, { label: string; hint: string }> = {
  familie: { label: "Familie", hint: "Radrouten bevorzugt, große Straßen gemieden, steile Anstiege teuer" },
  "familie-flach": { label: "Familie, so flach wie möglich", hint: "Wie Familie, nimmt für weniger und flachere Anstiege auch Umwege" },
  "familie-ruhig": { label: "Familie, möglichst ruhig", hint: "Meidet jede Straße ohne Radweg-Hinweis, kann deutlich längere Umwege machen" },
  trekking: { label: "Standard (BRouter Trekking)", hint: "Direkter, fährt auch auf Landstraßen" },
};

const PROFILE_PARAMS: Record<Exclude<RouteProfile, "trekking">, Record<string, string>> = {
  // Abgestimmt auf Testabschnitten (scripts/brouter_probe.py), z.B. Kinna–Mölnlycke:
  // trekking 52 km/432 Hm/max 14 %, familie 62 km/412 Hm/max 9 %, flach 72 km/414 Hm/max 7 %, ruhig 94 km/540 Hm
  familie: { UPHILLCOST: "120", UPHILLCUTOFF: "2.5", OFFROUTE: "0.05", PRIMARY: "4", SECONDARY: "2.0", AVOIDUNSAFE: "false", UNPAVED: "2.0" },
  "familie-flach": { UPHILLCOST: "250", UPHILLCUTOFF: "2", OFFROUTE: "0.05", PRIMARY: "4", SECONDARY: "2.0", AVOIDUNSAFE: "false", UNPAVED: "2.0" },
  "familie-ruhig": { UPHILLCOST: "120", UPHILLCUTOFF: "2.5", OFFROUTE: "0.05", PRIMARY: "4", SECONDARY: "2.0", AVOIDUNSAFE: "true", UNPAVED: "2.0" },
};

export function profileText(p: Exclude<RouteProfile, "trekking">): string {
  let t = familieTemplate;
  for (const [k, v] of Object.entries(PROFILE_PARAMS[p])) t = t.split(`{{${k}}}`).join(v);
  return t;
}

const BROUTER = "https://brouter.de/brouter";
const uploaded: Partial<Record<RouteProfile, string>> = {};

/** Lädt das Profil zum BRouter-Server hoch (einmal pro App-Start) und liefert dessen ID. */
async function profileId(p: RouteProfile, force = false): Promise<string> {
  if (p === "trekking") return "trekking";
  if (!force && uploaded[p]) return uploaded[p]!;
  const j = JSON.parse(await postText(`${BROUTER}/profile`, profileText(p)));
  if (!j.profileid) throw new Error(`Profil-Upload: ${j.error ?? "keine ID"}`);
  uploaded[p] = j.profileid;
  return j.profileid;
}

/** Fahrrad-Routing über den öffentlichen BRouter-Server (nur online, nur im Planungsmodus). */
export async function brouterRoute(waypoints: LonLat[], profile: RouteProfile = "familie"): Promise<LonLat[]> {
  if (waypoints.length < 2) throw new Error("Mindestens Start und Ziel nötig");
  const lonlats = waypoints.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|");
  const url = (id: string) => `${BROUTER}?lonlats=${encodeURIComponent(lonlats)}&profile=${id}&alternativeidx=0&format=geojson`;
  let gj: any;
  try {
    gj = await getJson(url(await profileId(profile)));
  } catch (e) {
    // Hochgeladene Profile löscht der Server nach einiger Zeit: einmal neu hochladen
    if (profile === "trekking") throw e;
    gj = await getJson(url(await profileId(profile, true)));
  }
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
