import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { load, save } from "./store";

/** Wo die Kartenpakete liegen (GitHub-Release, wird von .github/workflows/tiles.yml gebaut). */
export const TILES_BASE = "https://github.com/kuchenkabel/schweden-radtour-app/releases/download/tiles-latest";

export interface TilePack {
  region: string;
  path: string;
  uri: string;
  bytes: number;
  date: string;
}

export const listPacks = () => load<TilePack[]>("tilePacks", []);

export async function downloadPack(region: string, onProgress: (pct: number, mb: number) => void): Promise<TilePack> {
  if (!Capacitor.isNativePlatform()) throw new Error("Offline-Karten gibt es nur in der Android-App");
  const path = `tiles/${region}.pmtiles`;
  const handle = await Filesystem.addListener("progress", (p) => {
    if (p.contentLength > 0) onProgress(Math.round((p.bytes / p.contentLength) * 100), p.bytes / 1e6);
    else onProgress(-1, p.bytes / 1e6);
  });
  try {
    await Filesystem.downloadFile({
      url: `${TILES_BASE}/${region}.pmtiles`,
      path,
      directory: Directory.Data,
      recursive: true,
      progress: true,
    });
  } finally {
    await handle.remove();
  }
  const stat = await Filesystem.stat({ path, directory: Directory.Data });
  const pack: TilePack = { region, path, uri: stat.uri, bytes: stat.size, date: new Date().toISOString().slice(0, 10) };
  const packs = (await listPacks()).filter((p) => p.region !== region);
  packs.push(pack);
  await save("tilePacks", packs);
  return pack;
}

export async function deletePack(region: string): Promise<void> {
  const packs = await listPacks();
  const pack = packs.find((p) => p.region === region);
  if (pack) {
    try { await Filesystem.deleteFile({ path: pack.path, directory: Directory.Data }); } catch { /* schon weg */ }
  }
  await save("tilePacks", packs.filter((p) => p.region !== region));
}

/** Prüft grob, ob Internet da ist (navigator.onLine ist auf Android oft zu optimistisch). */
export async function isOnline(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch("https://tiles.openfreemap.org/styles/liberty", { method: "HEAD", signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}
