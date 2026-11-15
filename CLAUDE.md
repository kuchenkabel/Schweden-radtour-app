# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Offline-first app for a 3-week family bike tour in southern Sweden (July/Aug 2027). One TypeScript code base ships two ways:

- **WebApp** on GitHub Pages (used for planning at home, currently the main target).
- **Android APK** via Capacitor 7 (used on the road, target devices Xiaomi Redmi).

Everything user-facing (UI, docs, commit messages, PR titles, workflow names) is **German**. Keep it that way.
Product scope lives in `docs/SPEC.md`; data source research in `docs/datenquellen.md`; device sync in `docs/SYNC.md`; signing in `docs/SIGNIEREN.md`.

## Commands

```bash
npm ci
npm run fetch-data        # downloads POI/camp data (release data-latest) + map fonts into public/ (needed before build/dev)
SKIP_POIS=1 npm run fetch-data   # fonts only
npm run dev               # Vite dev server
npm run build             # tsc type check + vite build -> dist/
npm test                  # vitest run (all *.test.ts in src/)
npx vitest run src/stages.test.ts          # single test file
npx vitest run -t "Ruhetag"                # tests matching a name
node scripts/web_smoketest.mjs             # after build: serves dist/ on :4173, checks online services in Chromium
npx cap sync android                       # copy dist/ into the Android project
```

There is no linter; `tsc` (strict, via `npm run build`) is the static check.

## Architecture

- `src/main.ts` is the whole UI: one global state object `S`, five tabs (`planen`, `unterwegs`, `listen`, `notfall`, `mehr`), each with a `renderX()` returning an HTML string and a `bindX()` attaching listeners. Re-render = replace innerHTML and rebind. `recompute()` derives route km, POIs along the route, stages and day plans from `S.plan`. No framework.
- Logic modules are pure-ish and unit tested:
  - `geo.ts` (haversine, projection onto line, cumulative km, climb), `legs.ts` (Komoot-like editable route: waypoints + legs, routed vs. fixed/GPX legs, only dirty legs re-routed), `route.ts` (BRouter client, GPX parse/export; custom profile `src/brouter/familie.brf` is uploaded to BRouter),
  - `stages.ts` (split route into daily stages ending at sleep spots, rest days, elevation-weighted km), `sleep.ts` (sleep-spot ranking: water proximity, time of day/fatigue suggestions), `pois.ts` (compact POI format, categories `Cat`, POIs along route, tent permission), `eignung.ts` (wild-camp suitability raster grids per region), `weather.ts` (SMHI forecast, headwind, fire risk), `regions.ts` (region bboxes used for comparison and offline packs).
- Persistence: `store.ts` wraps Capacitor Preferences (localStorage in browser). `save()` fires a change listener that `sync.ts` uses to sync the keys `plan`, `people`, `checks`, `customItems` as one JSON file in a private GitHub repo via the Contents API (conflict prompt when both sides changed). Use `saveQuiet()` when applying remote state. Device-local keys (map packs, map height, API keys) are never synced.
- Platform split: check `Capacitor.isNativePlatform()`. `http.ts` uses CapacitorHttp natively (no CORS) and `fetch` in the browser. GitHub release assets have no CORS, so the WebApp ships eignung grids inside `dist/data/eignung/` (see `web.yml`) while the APK downloads them from the release.
- Maps: `map.ts` (MapLibre + Protomaps basemaps). Online style OpenFreeMap; offline uses per-region PMTiles downloaded by `offline.ts` from release `tiles-latest`, read via a custom native `FileRangePlugin` (Java, `android/app/src/main/java/de/familie/schwedenradtour/`). `IncomingFilePlugin` handles GPX opened/shared into the app.
- Static content (checklists, emergency texts, Swedish phrases, Xiaomi help) in `src/content/`; train/bike rules in `data/transport-rules.json`.

## Data pipeline (GitHub Actions + Python scripts)

Heavy data work runs in workflows, results go to GitHub releases that the app consumes:

| Workflow | Script(s) | Output |
| --- | --- | --- |
| `data.yml` (monthly) | osmium + `build_pois.py`, `fetch_refs.py` | `pois-sweden.json.gz` in `data-latest` |
| `camp.yml` (monthly) | `build_camp.py`, `fetch_protected.py`, `prep_worldcover.py` | `camp-sweden.json.gz`, `eignung-*.bin` in `data-latest` |
| `tiles.yml` (manual) | | PMTiles per region in `tiles-latest` |
| `route.yml` | `route_gpx.py` on `routes/*.json` | GPX in `route-latest` (BRouter is not reachable from the sandbox, so routing runs here) |
| `poster-data.yml` | | inputs for `scripts/poster/render_poster.py` (printable A3 map, rendered locally) |
| `web.yml` (push to main / PRs touching src) | tests, build, `web_smoketest.mjs` | GitHub Pages |
| `apk.yml` (**manual only for now**) | tests, build, cap sync, Gradle | `apk-latest` release; fails if not signed with the fixed release key |
| `smoketest.yml` | `smoketest_prefs.py` | emulator run; app `selftest()` triggered by prefs key `selftestDownload` |

Data format note: Android aapt strips `.gz` from assets, so bundled gzip data uses the `.bin` extension.

## Working conventions

- Work on a `claude/...` branch, open a PR to `main`; merging to `main` deploys the WebApp.
- Do not re-enable the APK push trigger or cut APK releases unless the user asks (planning happens in the WebApp until the field phase).
- Keystore/passwords are never committed (`*.keystore` is gitignored); signing uses repo secrets `KEYSTORE_B64` / `KEYSTORE_PASSWORD`.
