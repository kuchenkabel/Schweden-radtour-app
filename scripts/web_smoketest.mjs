// Browser-Test der WebApp: startet einen kleinen Server für dist/, öffnet die App in Chromium
// und prüft, ob die Online-Dienste (Routing, Wetter, Karte) aus dem Browser erreichbar sind (CORS).
// Aufruf: node scripts/web_smoketest.mjs   (nach npm run build)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = "dist";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4173);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:4173/");
await page.waitForSelector("#tabs button");
await page.waitForTimeout(3000);

// Echtes Familienprofil der App (Platzhalter wie in src/route.ts befüllt)
const { readFileSync } = await import("node:fs");
const familie = readFileSync(new URL("../src/brouter/familie.brf", import.meta.url), "utf8")
  .replace(/\{\{[A-Z]+\}\}/g, (m) => ({ "{{UPHILLCOST}}": "120", "{{UPHILLCUTOFF}}": "2.5", "{{OFFROUTE}}": "0.05", "{{PRIMARY}}": "4", "{{SECONDARY}}": "2.0", "{{AVOIDUNSAFE}}": "false", "{{UNPAVED}}": "2.0" })[m] ?? m);

const checks = await page.evaluate(async (familie) => {
  const tests = {
    "Routing (BRouter)": "https://brouter.de/brouter?lonlats=13.0,55.6|13.05,55.62&profile=trekking&alternativeidx=0&format=geojson",
    "Wetter (SMHI)": "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/13.0000/lat/55.6000/data.json",
    "Karte (OpenFreeMap)": "https://tiles.openfreemap.org/styles/liberty",
    "Eignungskarte (Gotland)": "data/eignung/eignung-gotland.bin",
    "POIs": "data/pois-sweden.bin",
  };
  const out = {};
  // Familienprofil hochladen (POST aus dem Browser) und damit routen
  try {
    const up = await fetch("https://brouter.de/brouter/profile", { method: "POST", body: familie, headers: { "Content-Type": "text/plain" } });
    const j = await up.json();
    const r = await fetch(`https://brouter.de/brouter?lonlats=13.0,55.6|13.05,55.62&profile=${j.profileid}&alternativeidx=0&format=geojson`);
    out["Eigenes BRouter-Profil"] = j.profileid && r.ok ? "ok" : `Upload ${JSON.stringify(j).slice(0, 80)}, Routing HTTP ${r.status}`;
  } catch (e) {
    out["Eigenes BRouter-Profil"] = `Fehler: ${e.message}`;
  }
  for (const [name, url] of Object.entries(tests)) {
    try {
      const r = await fetch(url);
      out[name] = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) {
      out[name] = `Fehler: ${e.message}`;
    }
  }
  return out;
}, familie);
await browser.close();
server.close();

let bad = 0;
for (const [name, res] of Object.entries(checks)) {
  console.log(`${res === "ok" ? "✓" : "✗"} ${name}: ${res}`);
  if (res !== "ok") bad++;
}
for (const e of errors) console.log(`✗ JS-Fehler: ${e}`);
if (bad || errors.length) process.exit(1);
