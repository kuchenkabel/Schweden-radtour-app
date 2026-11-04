import { getJson } from "./http";
import { bearingDeg, indexAtKm, type LonLat } from "./geo";

export interface WeatherHour {
  time: Date;
  temp?: number;
  /** m/s */
  wind: number;
  gust?: number;
  /** Grad, woher der Wind kommt */
  windFrom: number;
  /** mm/h */
  precip: number;
}

/**
 * SMHI-Punktprognose. Unterstützt das neue Format (snow1g, `data`-Objekt)
 * und das alte (pmp3g, `parameters`-Array).
 */
export async function smhiForecast(lon: number, lat: number): Promise<WeatherHour[]> {
  const urls = [
    `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`,
    `https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`,
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return parseSmhi(await getJson(url));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Wetter nicht abrufbar");
}

export function parseSmhi(json: any): WeatherHour[] {
  const ts: any[] = json.timeSeries ?? [];
  return ts.map((t) => {
    const time = new Date(t.validTime ?? t.time);
    if (t.data) {
      const d = t.data;
      return {
        time,
        temp: d.air_temperature,
        wind: d.wind_speed ?? 0,
        gust: d.wind_speed_of_gust,
        windFrom: d.wind_from_direction ?? 0,
        precip: d.precipitation_amount_mean ?? d.precipitation_amount_median ?? 0,
      };
    }
    const get = (n: string) => t.parameters?.find((p: any) => p.name === n)?.values?.[0];
    return { time, temp: get("t"), wind: get("ws") ?? 0, gust: get("gust"), windFrom: get("wd") ?? 0, precip: get("pmean") ?? 0 };
  });
}

/**
 * Gegenwind-Anteil entlang einer Strecke: mittlere Windkomponente gegen die Fahrtrichtung (m/s, positiv = Gegenwind).
 */
export function headwind(line: LonLat[], cum: number[], fromKm: number, toKm: number, windFrom: number, windSpeed: number): number {
  const i0 = indexAtKm(cum, fromKm), i1 = Math.max(i0 + 1, indexAtKm(cum, toKm));
  let sum = 0, len = 0;
  for (let i = i0; i < i1 && i < line.length - 1; i++) {
    const seg = cum[i + 1] - cum[i];
    if (seg <= 0) continue;
    const heading = bearingDeg(line[i], line[i + 1]);
    // Wind kommt aus windFrom: Gegenwind, wenn er aus Fahrtrichtung kommt
    const diff = ((windFrom - heading) * Math.PI) / 180;
    sum += Math.cos(diff) * windSpeed * seg;
    len += seg;
  }
  return len > 0 ? sum / len : 0;
}

/**
 * Faustregel für eine Familie mit Anhänger: je m/s Gegenwind ca. 5 % weniger Strecke,
 * Rückenwind hilft halb so viel. Begrenzung auf 50 % bis 115 %.
 */
export function feasibleKm(plannedKm: number, headwindMs: number): number {
  const f = headwindMs > 0 ? 1 - 0.05 * headwindMs : 1 - 0.025 * headwindMs;
  return Math.round(plannedKm * Math.max(0.5, Math.min(1.15, f)));
}

export function windDirName(deg: number): string {
  const names = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  return names[Math.round(((deg % 360) / 45)) % 8];
}

/** Brandrisiko (SMHI Fire Weather Index) als Tageswerte. */
export async function smhiFireRisk(lon: number, lat: number): Promise<{ date: string; fwi: number; idx?: number }[]> {
  const url = `https://opendata-download-metfcst.smhi.se/api/category/fwif1g/version/1/daily/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
  const json = await getJson(url);
  return (json.timeSeries ?? []).map((t: any) => {
    const get = (n: string) => t.parameters?.find((p: any) => p.name === n)?.values?.[0] ?? t.data?.[n];
    return { date: (t.validTime ?? t.time ?? "").slice(0, 10), fwi: get("fwi"), idx: get("fwiindex") };
  });
}
