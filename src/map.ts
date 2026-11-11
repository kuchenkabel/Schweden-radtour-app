import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { LonLat } from "./geo";
import { CAT_INFO, type Cat, type Poi } from "./pois";
import type { Stage } from "./stages";

const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
maplibregl.setWorkerUrl(new URL(workerUrl, location.href).href);
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

interface FileRangePlugin {
  read(o: { path: string; offset: number; length: number }): Promise<{ data: string }>;
  close(): Promise<void>;
}
const FileRange = registerPlugin<FileRangePlugin>("FileRange");

/** Liest Byte-Bereiche einer lokalen PMTiles-Datei über ein kleines natives Plugin. */
class LocalFileSource implements Source {
  constructor(private path: string, private key: string) {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const { data } = await FileRange.read({ path: this.path, offset, length });
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { data: out.buffer };
  }
}

export function offlineStyle(fileUri: string, key: string): StyleSpecification {
  // Im Browser (Entwicklung) per URL, in der App über das native Plugin
  protocol.add(new PMTiles(Capacitor.isNativePlatform() ? new LocalFileSource(fileUri, key) : fileUri));
  return {
    version: 8,
    glyphs: "fonts/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${key}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    // Ebenen mit Icons brauchen ein Sprite, das wir offline nicht haben
    layers: layers("protomaps", namedFlavor("light"), { lang: "de" }).filter((l: any) => !l.layout?.["icon-image"]),
  } as StyleSpecification;
}

/** Leerer Hintergrund, damit Route und Orte auch ohne Kartenpaket sichtbar sind. */
export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef2e6" } }],
};

export interface SatOptions {
  tiles: string;
  maxzoom: number;
  attribution: string;
}

export interface CheckOverlay {
  center: LonLat;
  radiusM: number;
  spots: { lon: number; lat: number; label: string; color: string }[];
}

export interface MapView {
  map: MlMap;
  setStyle(style: string | StyleSpecification): void;
  setRoute(line: LonLat[]): void;
  /** Wegpunkte; `editable` = als ziehbare Marker (Planen) */
  setWaypoints(pts: LonLat[], editable?: boolean): void;
  /** Wegpunkt i wurde auf p gezogen */
  onWaypointDrag(cb: (i: number, p: LonLat) => void): void;
  onWaypointClick(cb: (i: number) => void): void;
  /** Route an Stelle `at` angefasst und nach `to` gezogen (neuer Zwischenpunkt) */
  onRouteDrag(cb: (at: LonLat, to: LonLat) => void): void;
  /** Offizielle Radrouten (Waymarked Trails, online) ein-/ausblenden */
  setCycleRoutes(on: boolean): void;
  setStages(stages: Stage[], highlightDay?: number): void;
  setPois(pois: Poi[], visible: Set<Cat>): void;
  setVisibleCats(visible: Set<Cat>): void;
  onPoiClick(cb: (p: Poi) => void): void;
  fit(bbox: [number, number, number, number]): void;
  setPosition(p: LonLat | null): void;
  /** Luftbild-Ebene unter den App-Ebenen; null = aus */
  setSatellite(opts: SatOptions | null): void;
  /** Prüfpunkt mit Kreis und nummerierten Stellen; null = löschen */
  setCheck(c: CheckOverlay | null): void;
  /** Nächster Karten-Tipp wird als Punktwahl gemeldet (statt POI-Klick) */
  setPickMode(on: boolean): void;
  onPick(cb: (p: LonLat) => void): void;
}

export function createMap(container: HTMLElement, style: string | StyleSpecification = ONLINE_STYLE): MapView {
  const map = new maplibregl.Map({
    container,
    style,
    center: [14.5, 58.5],
    zoom: 5,
    attributionControl: { compact: true },
    // Schrift-Ordner ohne Leerzeichen (der App-Server mag keine %20 in Pfaden)
    transformRequest: (url) => ((url.startsWith("fonts/") || url.startsWith(location.origin)) && url.includes("fonts/") ? { url: url.replace(/(%20|\s)/g, "_") } : { url }),
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  let state = {
    route: [] as LonLat[],
    waypoints: [] as LonLat[],
    stages: [] as Stage[],
    highlight: undefined as number | undefined,
    pois: [] as Poi[],
    visible: new Set<Cat>(),
    pos: null as LonLat | null,
    sat: null as SatOptions | null,
    check: null as CheckOverlay | null,
    editable: false,
    cycle: false,
  };
  let markers: maplibregl.Marker[] = [];
  let wpDragCb: ((i: number, p: LonLat) => void) | null = null;
  let wpClickCb: ((i: number) => void) | null = null;
  let routeDragCb: ((at: LonLat, to: LonLat) => void) | null = null;
  let pickMode = false;
  let pickCb: ((p: LonLat) => void) | null = null;
  let poiCb: ((p: Poi) => void) | null = null;
  let poiById = new Map<number, Poi>();

  const fc = (features: any[]) => ({ type: "FeatureCollection" as const, features });

  function ensureLayers() {
    if (map.getSource("route")) return;
    map.addSource("route", { type: "geojson", data: fc([]) });
    map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#fff", "line-width": 7 }, layout: { "line-cap": "round", "line-join": "round" } });
    map.addLayer({
      id: "route", type: "line", source: "route",
      paint: { "line-color": ["case", ["==", ["get", "hl"], 1], "#d81b60", "#6a1b9a"], "line-width": 4 },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    map.addSource("pois", { type: "geojson", data: fc([]) });
    map.addLayer({
      id: "pois", type: "circle", source: "pois",
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3.5, 12, 7, 15, 9],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 12, 1.5],
      },
    });
    map.addLayer({
      id: "poi-labels", type: "symbol", source: "pois", minzoom: 13,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#333", "text-halo-color": "#fff", "text-halo-width": 1.5 },
    });
    map.addSource("stage-ends", { type: "geojson", data: fc([]) });
    map.addLayer({
      id: "stage-ends", type: "circle", source: "stage-ends",
      paint: { "circle-color": "#d81b60", "circle-radius": 9, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: "stage-labels", type: "symbol", source: "stage-ends",
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Medium"], "text-size": 11, "text-allow-overlap": true },
      paint: { "text-color": "#fff" },
    });
    map.addSource("waypoints", { type: "geojson", data: fc([]) });
    map.addLayer({
      id: "waypoints", type: "circle", source: "waypoints",
      paint: { "circle-color": "#ff6f00", "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    map.addSource("pos", { type: "geojson", data: fc([]) });
    map.addLayer({
      id: "pos", type: "circle", source: "pos",
      paint: { "circle-color": "#1976d2", "circle-radius": 8, "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
    });
    map.addSource("check", { type: "geojson", data: fc([]) });
    map.addLayer({ id: "check-fill", type: "fill", source: "check", filter: ["==", ["get", "k"], "circle"], paint: { "fill-color": "#1976d2", "fill-opacity": 0.08 } });
    map.addLayer({ id: "check-line", type: "line", source: "check", filter: ["==", ["get", "k"], "circle"], paint: { "line-color": "#1976d2", "line-width": 2, "line-dasharray": [2, 2] } });
    map.addLayer({
      id: "check-pts", type: "circle", source: "check", filter: ["!=", ["get", "k"], "circle"],
      paint: { "circle-color": ["get", "color"], "circle-radius": ["case", ["==", ["get", "k"], "x"], 8, 12], "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
    });
    map.addLayer({
      id: "check-labels", type: "symbol", source: "check", filter: ["==", ["get", "k"], "spot"],
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Medium"], "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": "#fff" },
    });
    applySat();
    applyCycle();
    redraw();
    drawMarkers();
  }

  function applySat() {
    if (map.getLayer("sat")) map.removeLayer("sat");
    if (map.getSource("sat")) map.removeSource("sat");
    const o = state.sat;
    if (!o || !map.getSource("route")) return;
    map.addSource("sat", { type: "raster", tiles: [o.tiles], tileSize: 256, maxzoom: o.maxzoom, attribution: o.attribution });
    map.addLayer({ id: "sat", type: "raster", source: "sat" }, "route-casing");
  }

  function circlePolygon(c: LonLat, rM: number) {
    const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 110574;
    const ring: [number, number][] = [];
    for (let a = 0; a <= 64; a++) {
      const t = (a / 64) * 2 * Math.PI;
      ring.push([c[0] + (rM * Math.sin(t)) / kx, c[1] + (rM * Math.cos(t)) / ky]);
    }
    return { type: "Polygon" as const, coordinates: [ring] };
  }

  function drawCheck() {
    const src = map.getSource("check") as GeoJSONSource | undefined;
    if (!src) return;
    const c = state.check;
    if (!c) return src.setData(fc([]));
    src.setData(fc([
      { type: "Feature", properties: { k: "circle" }, geometry: circlePolygon(c.center, c.radiusM) },
      { type: "Feature", properties: { k: "x", color: "#d81b60" }, geometry: { type: "Point", coordinates: [c.center[0], c.center[1]] } },
      ...c.spots.map((s) => ({ type: "Feature", properties: { k: "spot", label: s.label, color: s.color }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })),
    ]));
  }

  function redraw() {
    if (!map.getSource("route")) return;
    const routeFeatures: any[] = [];
    if (state.route.length > 1) {
      routeFeatures.push({ type: "Feature", properties: { hl: 0 }, geometry: { type: "LineString", coordinates: state.route.map((p) => [p[0], p[1]]) } });
    }
    (map.getSource("route") as GeoJSONSource).setData(fc(routeFeatures));
    (map.getSource("stage-ends") as GeoJSONSource).setData(
      fc(state.stages.map((s, i) => ({
        type: "Feature",
        properties: { label: String(s.day), i },
        geometry: { type: "Point", coordinates: s.end ? [s.end.lon, s.end.lat] : endOf(s) },
      }))),
    );
    (map.getSource("waypoints") as GeoJSONSource).setData(
      fc((state.editable ? [] : state.waypoints).map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p[0], p[1]] } }))),
    );
    drawPois();
    drawCheck();
    (map.getSource("pos") as GeoJSONSource).setData(
      fc(state.pos ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [state.pos[0], state.pos[1]] } }] : []),
    );
  }

  function drawMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
    if (!state.editable) return;
    const n = state.waypoints.length;
    state.waypoints.forEach((p, i) => {
      const el = document.createElement("div");
      const kind = i === 0 ? "start" : i === n - 1 && n > 1 ? "ziel" : "via";
      el.className = `wp-marker ${kind}`;
      el.textContent = kind === "start" ? "S" : kind === "ziel" ? "Z" : "";
      el.title = "Ziehen zum Verschieben, Tippen für Optionen";
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p[0], p[1]]).addTo(map);
      let moved = false;
      m.on("dragstart", () => { moved = true; });
      m.on("dragend", () => {
        const ll = m.getLngLat();
        wpDragCb?.(i, [ll.lng, ll.lat]);
        setTimeout(() => { moved = false; }, 50);
      });
      el.addEventListener("click", (ev) => { ev.stopPropagation(); if (!moved) wpClickCb?.(i); });
      markers.push(m);
    });
  }

  function applyCycle() {
    if (map.getLayer("cycle")) map.removeLayer("cycle");
    if (map.getSource("cycle")) map.removeSource("cycle");
    if (!state.cycle || !map.getSource("route")) return;
    map.addSource("cycle", {
      type: "raster", tiles: ["https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 17,
      attribution: '<a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a> (CC BY-SA)',
    });
    map.addLayer({ id: "cycle", type: "raster", source: "cycle", paint: { "raster-opacity": 0.85 } }, "route-casing");
  }

  function endOf(s: Stage): [number, number] {
    // Ohne Schlafplatz (letzte Etappe): Routenende
    const last = state.route[state.route.length - 1];
    return last ? [last[0], last[1]] : [0, 0];
  }

  function drawPois() {
    const src = map.getSource("pois") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      fc(state.pois.filter((p) => state.visible.has(p.cat)).map((p) => ({
        type: "Feature",
        properties: { id: p.id, color: CAT_INFO[p.cat].color, name: p.name || CAT_INFO[p.cat].label },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      }))),
    );
  }

  map.on("style.load", ensureLayers);
  map.on("error", (e: any) => console.log(`[map] Fehler: ${e?.error?.message ?? e}`));
  map.on("idle", () => console.log(`[map] bereit, Zoom ${map.getZoom().toFixed(1)}`));
  // Punkte sind auf dem Handy klein: Tipps im Umkreis von TAP_PX Pixeln zählen,
  // der nächstgelegene Punkt gewinnt. Tagesnummern (Etappenenden) haben Vorrang
  // und öffnen den Schlafplatz der Etappe.
  const TAP_PX = 18;
  const nearestAt = (x: number, y: number, layer: string) => {
    if (!map.getLayer(layer)) return null;
    let best: any = null, bestD = Infinity;
    for (const f of map.queryRenderedFeatures([[x - TAP_PX, y - TAP_PX], [x + TAP_PX, y + TAP_PX]], { layers: [layer] })) {
      const pt = map.project((f.geometry as any).coordinates as [number, number]);
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  };
  map.on("click", (e: any) => {
    if (!poiCb || pickMode) return;
    const { x, y } = e.point;
    const st = nearestAt(x, y, "stage-ends");
    const end = st ? state.stages[Number(st.properties?.i)]?.end : null;
    if (end) { poiCb(end); return; }
    const f = nearestAt(x, y, "pois");
    const p = f ? poiById.get(Number(f.properties?.id)) : undefined;
    if (p) poiCb(p);
  });
  const pick = (e: any) => { pickCb?.([e.lngLat.lng, e.lngLat.lat]); };
  map.on("click", (e: any) => {
    if (!pickMode) return;
    // Erst nach dem POI-Handler zurücksetzen, damit der Tipp kein POI öffnet
    setTimeout(() => { pickMode = false; }, 0);
    pick(e);
  });
  map.on("contextmenu", (e: any) => pick(e));
  // Route anfassen und ziehen = neuer Zwischenpunkt (nur Planen, wie bei Komoot)
  let ghost: maplibregl.Marker | null = null;
  let dragStart: { at: LonLat; x: number; y: number } | null = null;
  const startRouteDrag = (e: any) => {
    if (!state.editable || !routeDragCb || pickMode || state.route.length < 2) return;
    if (e.originalEvent?.touches && e.originalEvent.touches.length > 1) return;
    const { x, y } = e.point;
    if (!map.getLayer("route")) return;
    const hits = map.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]], { layers: ["route"] });
    if (!hits.length) return;
    e.preventDefault(); // Karte nicht verschieben
    dragStart = { at: [e.lngLat.lng, e.lngLat.lat], x, y };
  };
  const moveRouteDrag = (e: any) => {
    if (!dragStart) return;
    const { x, y } = e.point;
    if (!ghost && Math.hypot(x - dragStart.x, y - dragStart.y) < 8) return;
    if (!ghost) {
      const el = document.createElement("div");
      el.className = "wp-marker via ghost";
      ghost = new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map);
    }
    ghost.setLngLat(e.lngLat);
  };
  const endRouteDrag = () => {
    if (!dragStart) return;
    const start = dragStart;
    dragStart = null;
    if (ghost) {
      const ll = ghost.getLngLat();
      ghost.remove();
      ghost = null;
      routeDragCb?.(start.at, [ll.lng, ll.lat]);
    }
  };
  map.on("mousedown", startRouteDrag);
  map.on("touchstart", startRouteDrag);
  map.on("mousemove", moveRouteDrag);
  map.on("touchmove", moveRouteDrag);
  map.on("mouseup", endRouteDrag);
  map.on("touchend", endRouteDrag);
  map.on("touchcancel", () => { dragStart = null; ghost?.remove(); ghost = null; });
  map.on("mouseenter", "pois", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "pois", () => (map.getCanvas().style.cursor = ""));

  return {
    map,
    setStyle(style) { map.setStyle(style); },
    setRoute(line) { state.route = line; redraw(); },
    setWaypoints(pts, editable = false) {
      const same = editable === state.editable && pts.length === state.waypoints.length && pts.every((p, i) => p[0] === state.waypoints[i][0] && p[1] === state.waypoints[i][1]);
      state.waypoints = pts; state.editable = editable;
      redraw();
      if (!same) drawMarkers();
    },
    onWaypointDrag(cb) { wpDragCb = cb; },
    onWaypointClick(cb) { wpClickCb = cb; },
    onRouteDrag(cb) { routeDragCb = cb; },
    setCycleRoutes(on) { state.cycle = on; applyCycle(); },
    setStages(stages, hl) { state.stages = stages; state.highlight = hl; redraw(); },
    setPois(pois, visible) {
      state.pois = pois; state.visible = visible;
      poiById = new Map(pois.map((p) => [p.id, p]));
      drawPois();
    },
    setVisibleCats(visible) { state.visible = visible; drawPois(); },
    onPoiClick(cb) { poiCb = cb; },
    fit(b) { map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 600 }); },
    setPosition(p) { state.pos = p; redraw(); },
    setSatellite(opts) { state.sat = opts; applySat(); },
    setCheck(c) { state.check = c; drawCheck(); },
    setPickMode(on) { pickMode = on; map.getCanvas().style.cursor = on ? "crosshair" : ""; },
    onPick(cb) { pickCb = cb; },
  };
}

export { ONLINE_STYLE };
