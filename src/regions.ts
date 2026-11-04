import type { Cat, PoiIndex } from "./pois";

export interface Region {
  id: string;
  name: string;
  /** [West, Süd, Ost, Nord] */
  bbox: [number, number, number, number];
  hint: string;
}

/** Tourenregionen für Vergleich und Offline-Kartenpakete (Bounding-Boxen grob, dürfen sich überlappen). */
export const REGIONS: Region[] = [
  { id: "skane", name: "Skåne", bbox: [12.4, 55.3, 14.6, 56.5], hint: "Flach, viele Radwege (Sydkustleden, Skåneleden), dicht besiedelt" },
  { id: "halland", name: "Halland / Kattegattleden", bbox: [11.9, 56.3, 13.4, 57.6], hint: "Kattegattleden: autofreier Küstenradweg, Strände, oft Westwind" },
  { id: "bohuslan", name: "Göteborg & Bohuslän", bbox: [10.9, 57.5, 12.6, 59.1], hint: "Schären, hügelig, viele Badestellen" },
  { id: "vastergotland", name: "Västergötland & Vättern", bbox: [12.4, 57.6, 15.0, 59.0], hint: "Seen Vänern/Vättern, Göta kanal (Treidelpfad)" },
  { id: "smaland", name: "Småland & Öland", bbox: [13.3, 56.3, 17.2, 58.1], hint: "Wald und Seen, viele Vindskydd, Öland flach" },
  { id: "blekinge", name: "Blekinge", bbox: [14.0, 55.95, 16.0, 56.6], hint: "Sydostleden, Schärenküste" },
  { id: "ostergotland", name: "Östergötland & Sörmland", bbox: [14.8, 57.7, 17.8, 59.4], hint: "Göta kanal Ostteil, Schärengarten" },
  { id: "malardalen", name: "Stockholm & Mälardalen", bbox: [15.5, 59.0, 19.2, 60.7], hint: "Gute Bahnanbindung, Mälaren-Rundtour" },
  { id: "varmland", name: "Dalsland & Värmland", bbox: [11.6, 58.6, 14.5, 60.5], hint: "Klarälvsbanan (Bahntrasse), Wildnis, Seen" },
  { id: "dalarna", name: "Dalarna & Siljan", bbox: [12.5, 60.0, 16.8, 62.3], hint: "Siljansleden, Hügel, Sommerkultur" },
  { id: "gotland", name: "Gotland", bbox: [18.0, 56.8, 19.4, 58.0], hint: "Insel, flach, Fähre ab Nynäshamn/Oskarshamn" },
];

export function regionAreaKm2(r: Region): number {
  const [w, s, e, n] = r.bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return (e - w) * 111.32 * Math.cos(midLat) * (n - s) * 110.574;
}

export const COMPARE_CATS: Cat[] = ["badplats", "vindskydd", "camping", "stf", "spielplatz", "supermarkt", "apotek", "bahnhof"];

export interface RegionStats {
  region: Region;
  areaKm2: number;
  counts: Record<Cat, number>;
  /** pro 1000 km² */
  density: Partial<Record<Cat, number>>;
  /** Punkte 0–100 für Familientauglichkeit (relativ zu den anderen Regionen) */
  score: number;
}

/**
 * Vergleicht Regionen anhand der POI-Dichte. Gewichtung nach Familien-Konzept:
 * Badestellen und Schlafplätze am wichtigsten, dann Versorgung und Bail-out.
 */
export function compareRegions(index: PoiIndex): RegionStats[] {
  const weights: Partial<Record<Cat, number>> = {
    badplats: 3, vindskydd: 2, camping: 2.5, stf: 1, spielplatz: 1, supermarkt: 1.5, apotek: 1, bahnhof: 1.5,
  };
  const stats = REGIONS.map((region) => {
    const counts = {} as Record<Cat, number>;
    for (const p of index.inBbox(...region.bbox)) counts[p.cat] = (counts[p.cat] ?? 0) + 1;
    const areaKm2 = regionAreaKm2(region);
    const density: Partial<Record<Cat, number>> = {};
    for (const c of COMPARE_CATS) density[c] = ((counts[c] ?? 0) / areaKm2) * 1000;
    return { region, areaKm2, counts, density, score: 0 };
  });
  // Normieren je Kategorie auf das Maximum, dann gewichtet summieren
  const max: Partial<Record<Cat, number>> = {};
  for (const c of COMPARE_CATS) max[c] = Math.max(...stats.map((s) => s.density[c] ?? 0)) || 1;
  const wSum = Object.values(weights).reduce((a, b) => a + (b ?? 0), 0);
  for (const s of stats) {
    let v = 0;
    for (const c of COMPARE_CATS) v += ((s.density[c] ?? 0) / max[c]!) * (weights[c] ?? 0);
    s.score = Math.round((v / wSum) * 100);
  }
  return stats.sort((a, b) => b.score - a.score);
}
