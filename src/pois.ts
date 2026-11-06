import { cumulativeKm, haversineKm, projectOnLine, type LonLat } from "./geo";

export type Cat =
  | "vindskydd" | "huette" | "camping" | "stf" | "hostel" | "badplats" | "spielplatz"
  | "wasser" | "wc" | "supermarkt" | "radladen" | "gas" | "apotek" | "vard" | "bahnhof"
  | "unterstand" | "zeltplatz";

export interface Poi {
  id: number;
  cat: Cat;
  lon: number;
  lat: number;
  name: string;
  x: Record<string, string>;
}

export const CAT_INFO: Record<Cat, { label: string; icon: string; color: string; sleep?: boolean }> = {
  vindskydd: { label: "Vindskydd", icon: "⛺", color: "#2e7d32", sleep: true },
  huette: { label: "Hütte", icon: "🛖", color: "#558b2f", sleep: true },
  camping: { label: "Campingplatz", icon: "🏕️", color: "#00838f", sleep: true },
  stf: { label: "STF-Haus", icon: "🏠", color: "#1565c0", sleep: true },
  hostel: { label: "Hostel", icon: "🛏️", color: "#3949ab", sleep: true },
  badplats: { label: "Badestelle", icon: "🏊", color: "#0288d1" },
  spielplatz: { label: "Spielplatz", icon: "🛝", color: "#f9a825" },
  wasser: { label: "Trinkwasser", icon: "🚰", color: "#0277bd" },
  wc: { label: "WC", icon: "🚻", color: "#6d4c41" },
  supermarkt: { label: "Supermarkt", icon: "🛒", color: "#ef6c00" },
  radladen: { label: "Fahrradladen", icon: "🔧", color: "#5d4037" },
  gas: { label: "Outdoor/Baumarkt (Gas)", icon: "🔥", color: "#bf360c" },
  apotek: { label: "Apotek", icon: "💊", color: "#c62828" },
  vard: { label: "Vårdcentral/Klinik", icon: "🏥", color: "#d32f2f" },
  bahnhof: { label: "Bahnhof", icon: "🚆", color: "#455a64" },
  zeltplatz: { label: "Zeltplatz-Kandidat", icon: "🌲", color: "#388e3c", sleep: true },
  unterstand: { label: "Unterstand (unsicher)", icon: "❔", color: "#9e9e9e" },
};

export const EXTRA_LABELS: Record<string, string> = {
  oh: "Öffnungszeiten", web: "Webseite", tel: "Telefon", op: "Betreiber", fee: "Gebühr",
  dw: "Trinkwasser", wc: "Toiletten", sh: "Dusche", wm: "Waschmaschine", res: "Reservierung",
  tent: "Zelte", cap: "Kapazität", fire: "Feuerstelle", bike: "Fahrrad", rs: "Rollstuhl",
  desc: "Beschreibung", acc: "Zugang", chk: "Zuletzt in OSM geprüft", typ: "Art (OSM)",
};

/** Einfaches Gitter-Raster für schnelle Umkreis-Abfragen (Zelle ca. 0,1° = ~6-11 km). */
export class PoiIndex {
  readonly all: Poi[];
  private grid = new Map<string, Poi[]>();
  private static CELL = 0.1;
  readonly generated: string;

  constructor(data: { cats: string[]; pois: any[][]; generated?: string }) {
    this.generated = data.generated ?? "";
    this.all = data.pois.map((p, id) => ({
      id,
      cat: data.cats[p[0]] as Cat,
      lat: p[1] / 1e5,
      lon: p[2] / 1e5,
      name: p[3] || "",
      x: (p[4] as Record<string, string>) || {},
    }));
    for (const p of this.all) {
      const k = this.key(p.lon, p.lat);
      let cell = this.grid.get(k);
      if (!cell) this.grid.set(k, (cell = []));
      cell.push(p);
    }
  }

  /** Fügt weitere POIs hinzu; ids bleiben der Index in `all`. */
  add(pois: Omit<Poi, "id">[]) {
    for (const q of pois) {
      const p: Poi = { ...q, id: this.all.length };
      this.all.push(p);
      const k = this.key(p.lon, p.lat);
      let cell = this.grid.get(k);
      if (!cell) this.grid.set(k, (cell = []));
      cell.push(p);
    }
  }

  private key(lon: number, lat: number) {
    return `${Math.floor(lon / PoiIndex.CELL)}:${Math.floor(lat / PoiIndex.CELL)}`;
  }

  /** Alle POIs in der Bounding-Box. */
  inBbox(w: number, s: number, e: number, n: number, cats?: Set<Cat>): Poi[] {
    const out: Poi[] = [];
    const C = PoiIndex.CELL;
    for (let x = Math.floor(w / C); x <= Math.floor(e / C); x++) {
      for (let y = Math.floor(s / C); y <= Math.floor(n / C); y++) {
        const cell = this.grid.get(`${x}:${y}`);
        if (!cell) continue;
        for (const p of cell) {
          if (p.lon < w || p.lon > e || p.lat < s || p.lat > n) continue;
          if (cats && !cats.has(p.cat)) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  nearest(pt: LonLat, cats: Set<Cat>, maxKm = 50, limit = 5): { poi: Poi; km: number }[] {
    const dLat = maxKm / 111;
    const dLon = maxKm / (111 * Math.cos((pt[1] * Math.PI) / 180));
    return this.inBbox(pt[0] - dLon, pt[1] - dLat, pt[0] + dLon, pt[1] + dLat, cats)
      .map((poi) => ({ poi, km: haversineKm(pt, [poi.lon, poi.lat]) }))
      .filter((r) => r.km <= maxKm)
      .sort((a, b) => a.km - b.km)
      .slice(0, limit);
  }
}

export interface RoutePoi {
  poi: Poi;
  /** km entlang der Route */
  alongKm: number;
  /** Abstand zur Route in km */
  offKm: number;
}

/**
 * Alle POIs, die höchstens `corridorKm` von der Route entfernt sind, sortiert nach Routen-km.
 * Läuft einmal pro Route (auch für lange Routen < 1 s).
 */
export function poisAlongRoute(
  index: PoiIndex,
  line: LonLat[],
  corridorKm = 2,
  cum = cumulativeKm(line),
): RoutePoi[] {
  const dLat = corridorKm / 111;
  const seen = new Map<number, RoutePoi>();
  // Route in Abschnitte von ~5 km teilen und pro Abschnitt Kandidaten holen
  let start = 0;
  while (start < line.length - 1) {
    let end = start;
    while (end < line.length - 1 && cum[end] - cum[start] < 5) end++;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (let i = start; i <= end; i++) {
      const p = line[i];
      w = Math.min(w, p[0]); e = Math.max(e, p[0]);
      s = Math.min(s, p[1]); n = Math.max(n, p[1]);
    }
    const dLon = corridorKm / (111 * Math.cos((s * Math.PI) / 180));
    for (const poi of index.inBbox(w - dLon, s - dLat, e + dLon, n + dLat)) {
      const pr = projectOnLine([poi.lon, poi.lat], line, cum, start, end);
      if (pr.offKm > corridorKm) continue;
      const prev = seen.get(poi.id);
      if (!prev || pr.offKm < prev.offKm) seen.set(poi.id, { poi, alongKm: pr.alongKm, offKm: pr.offKm });
    }
    start = end;
  }
  return [...seen.values()].sort((a, b) => a.alongKm - b.alongKm);
}

async function fetchGzipJson(url: string, label: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} nicht gefunden (${res.status})`);
  console.log(`[pois] ${url} geladen`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")));
    text = await ds.text();
  } else {
    text = new TextDecoder().decode(bytes); // Server hat schon entpackt
  }
  return JSON.parse(text);
}

/** Lädt die POI-Datei (gzip) aus dem App-Paket. */
export async function loadPois(url = "data/pois-sweden.bin"): Promise<PoiIndex> {
  return new PoiIndex(await fetchGzipJson(url, "POI-Datei"));
}

const CAMP_GROUND: Record<number, string> = {
  111: "Kiefernwald", 112: "Fichtenwald", 113: "Nadel-Mischwald", 114: "Mischwald",
  115: "Laubwald", 116: "Edellaubwald", 117: "Laub-/Edellaubwald", 42: "offenes Grasland/Heide",
};

/** Lädt die Zeltplatz-Kandidaten (optional) und fügt sie dem Index hinzu. */
export async function loadCamp(index: PoiIndex, url = "data/camp-sweden.bin"): Promise<number> {
  let data: { pts: number[][] };
  try {
    data = await fetchGzipJson(url, "Zeltplatz-Datei");
  } catch (e) {
    console.warn(`[pois] Zeltplatz-Kandidaten fehlen: ${(e as Error).message}`);
    return 0;
  }
  const pts = data.pts ?? [];
  index.add(
    pts.map((p) => ({
      cat: "zeltplatz" as Cat,
      lat: p[0] / 1e5,
      lon: p[1] / 1e5,
      name: "",
      x: {
        sc: String(p[2]),
        hs: String(p[3]),
        sl: (p[4] / 10).toFixed(1),
        wa: String(p[5]),
        ac: String(p[6]),
        gr: CAMP_GROUND[p[7]] ?? "unbekannt",
        ...(p[8] ? { res: "1" } : {}),
      },
    })),
  );
  console.log(`[pois] ${pts.length} Zeltplatz-Kandidaten`);
  return pts.length;
}
