// Hinweis: Android (aapt) entfernt die Endung .gz aus App-Assets, daher .bin.
// Lädt Datenpaket (POIs) und Kartenschriften nach public/, bevor die App gebaut wird.
// Aufruf: node scripts/fetch-data.mjs   (GITHUB_TOKEN optional, nötig bei privatem Repo)
import { mkdir, writeFile, access } from "node:fs/promises";

const REPO = "kuchenkabel/schweden-radtour-app";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const RANGES = ["0-255", "256-511", "512-767", "768-1023", "8192-8447"];
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

await mkdir("public/data", { recursive: true });
if (process.env.SKIP_POIS !== "1") {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const rel = JSON.parse((await get(`https://api.github.com/repos/${REPO}/releases/tags/data-latest`, auth)).toString());
  const asset = rel.assets.find((a) => a.name === "pois-sweden.json.gz");
  if (!asset) throw new Error("pois-sweden.json.gz fehlt im Release data-latest");
  const buf = await get(asset.url, { ...auth, Accept: "application/octet-stream" });
  await writeFile("public/data/pois-sweden.bin", buf);
  console.log(`POIs: ${(buf.length / 1e6).toFixed(2)} MB`);
}

for (const font of FONTS) {
  const dir = `public/fonts/${font.replace(/ /g, "_")}`;
  await mkdir(dir, { recursive: true });
  for (const r of RANGES) {
    const file = `${dir}/${r}.pbf`;
    if (await exists(file)) continue;
    const url = `https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/${encodeURIComponent(font)}/${r}.pbf`;
    await writeFile(file, await get(url));
  }
}
console.log("Schriften geladen");
