# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Offline-first app for a family bike tour in Sweden (summer 2027). The same TypeScript code ships as:
- an **Android APK** (Capacitor 7, target devices: Xiaomi Redmi), released as `apk-latest`
- a **WebApp** on GitHub Pages (`kuchenkabel.github.io/schweden-radtour-app`), used for planning on a laptop

UI text, docs, commit messages and PR descriptions are **German**.

## Commands

```bash
npm ci
npm run fetch-data      # POIs + Zeltplatz-Daten (Release data-latest) und Kartenschriften nach public/
npm run dev             # Vite dev server (Browser)
npm run build           # tsc -p . && vite build -> dist/
npm test                # vitest run (alle Tests)
npx vitest run src/stages.test.ts            # eine Testdatei
npx vitest run src/stages.test.ts -t "Ruhetage"   # ein einzelner Test
node scripts/web_smoketest.mjs   # nach build: dist/ in Chromium öffnen, CORS der Online-Dienste prüfen
```

There is no linter; `tsc` (strict, via `npm run build`) is the type check. The Android build (`npx cap sync android` + Gradle) and all data pipelines run **only in GitHub Actions**.

## Release flow

Work on a branch, open a PR, merge to `main`. A merge to `main` triggers:
- `apk.yml` → signed APK in release `apk-latest` (fails if not signed with the fixed release key, see `docs/SIGNIEREN.md`), then `smoketest.yml` runs it in an emulator
- `web.yml` → build, copy `eignung-*.bin` from `data-latest` into `dist/data/eignung/`, Playwright browser test, deploy to Pages (PRs run build+test only)

Data workflows publish to releases that the app downloads at runtime: `data.yml` (POIs from OSM, monthly → `data-latest`), `camp.yml` (Zeltplatz-Kandidaten / Eignungskarten), `tiles.yml` (PMTiles per region → `tiles-latest`, manual), `route.yml` (BRouter routes from `routes/*.json` → `route-latest`).

## Architecture

- `src/main.ts` is the whole UI: global state object `S`, five tabs (Planen, Unterwegs, Listen, Notfall, Mehr), each a `renderX()` returning an HTML string plus a `bindX()` that attaches listeners. `render()` redraws the active tab; `recompute()` rebuilds route POIs, stages and day plan, then `updateMap()`.
- Persistence: `store.ts` wraps `@capacitor/preferences` (SharedPreferences on Android, `localStorage` with prefix `CapacitorStorage.` in the browser). `save()` fires a change listener that the sync uses; `saveQuiet()` does not.
- `plan.ts`: `TourPlan` (waypoints, line, legs, settings, pinned stage ends, done days). Always load through `loadPlan()`/`normalizePlan()`: imported or synced plans can lack fields, and missing `settings` used to crash the app.
- `sync.ts`: optional laptop↔phone sync of the keys `plan`, `people`, `checks`, `customItems` into `radtour-sync.json` in a private GitHub repo via the Contents API (user token; `RT1-…` sync code carries repo+token). Last writer wins; if both sides changed, the UI asks. See `docs/SYNC.md`.
- Route editing: `legs.ts` (Komoot-like legs between waypoints; GPX legs are fixed, edits reroute only ±`ANCHOR_KM`), `route.ts` (BRouter on brouter.de; the custom profile `src/brouter/familie.brf` is uploaded via `POST /brouter/profile` with parameters substituted per profile variant).
- Stage planning: `stages.ts` `planStages()` is a DP over sleep-spot candidates along the route (cost = deviation from target km incl. Höhenmeter, sleep-spot penalty from `sleep.ts`); `toDayPlan()` inserts rest days and warnings. `sleep.ts` also ranks "heute Nacht" suggestions. Which POIs may end a stage is decided by `isSleepSpot()` in `pois.ts` (excludes campsites with OSM `tents=no`).
- `pois.ts`: compact POI index (gzipped JSON loaded from `data/pois-sweden.bin` + `data/camp-sweden.bin`), category table `CAT_INFO`, corridor search `poisAlongRoute()`.
- `eignung.ts`: wild-camping suitability grids per region (`eignung-<region>.bin`); `map.ts`: MapLibre with online style (OpenFreeMap) or offline PMTiles packs (`offline.ts`); `weather.ts`: SMHI forecast/fire risk.
- Native Android code in `android/app/src/main/java/...`: `FileRangePlugin` (byte-range reads of local PMTiles) and `IncomingFilePlugin` (GPX via "Öffnen mit"/"Teilen").
- `scripts/*.py` are the data pipelines run in Actions (POIs from OSM, campsite candidates, protected areas, route GPX, BRouter profile probing).

## Platform gotchas

- Branch on `Capacitor.isNativePlatform()` for anything native: offline map packs, file downloads, notifications and Share are app-only; the browser always uses the online map.
- GitHub release downloads have **no CORS**: the browser cannot fetch from `releases/download/...`. Anything the WebApp needs must be copied into `dist/` by `web.yml` (as done for `eignung-*.bin`) and loaded via a relative URL.
- Android `aapt` strips `.gz` from asset names, so gzipped data files are named `.bin`.
- Capacitor's local server ignores HTTP Range, hence the native `FileRange` plugin for PMTiles.
- `Filesystem.downloadFile` on Android does not create parent directories; call `ensureDir()` first.
- Keep `capacitor.config.json` as JSON: TypeScript 7 breaks `capacitor.config.ts`.
- Public BRouter returns 403 after about 20 rapid requests; URL `profile:x=` parameters cause HTTP 500 (that is why the profile gets uploaded).
- XML-escape names in generated GPX (a bare `&` makes the import fail).
- For local Playwright screenshots, serve `.mjs` as `text/javascript` (MapLibre worker) and launch Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`, otherwise the map stays blank.
