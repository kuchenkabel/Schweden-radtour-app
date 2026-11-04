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

export interface MapView {
  map: MlMap;
  setStyle(style: string | StyleSpecification): void;
  setRoute(line: LonLat[]): void;
  setWaypoints(pts: LonLat[]): void;
  setStages(stages: Stage[], highlightDay?: number): void;
  setPois(pois: Poi[], visible: Set<Cat>): void;
  setVisibleCats(visible: Set<Cat>): void;
  onPoiClick(cb: (p: Poi) => void): void;
  fit(bbox: [number, number, number, number]): void;
  setPosition(p: LonLat | null): void;
}

export function createMap(container: HTMLElement, style: string | StyleSpecification = ONLINE_STYLE): MapView {
  const map = new maplibregl.Map({
    container,
    style,
    center: [14.5, 58.5],
    zoom: 5,
    attributionControl: { compact: true },
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
  };
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
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 12, 6, 15, 8],
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
    redraw();
  }

  function redraw() {
    if (!map.getSource("route")) return;
    const routeFeatures: any[] = [];
    if (state.route.length > 1) {
      routeFeatures.push({ type: "Feature", properties: { hl: 0 }, geometry: { type: "LineString", coordinates: state.route.map((p) => [p[0], p[1]]) } });
    }
    (map.getSource("route") as GeoJSONSource).setData(fc(routeFeatures));
    (map.getSource("stage-ends") as GeoJSONSource).setData(
      fc(state.stages.map((s) => ({
        type: "Feature",
        properties: { label: String(s.day) },
        geometry: { type: "Point", coordinates: s.end ? [s.end.lon, s.end.lat] : endOf(s) },
      }))),
    );
    (map.getSource("waypoints") as GeoJSONSource).setData(
      fc(state.waypoints.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p[0], p[1]] } }))),
    );
    drawPois();
    (map.getSource("pos") as GeoJSONSource).setData(
      fc(state.pos ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [state.pos[0], state.pos[1]] } }] : []),
    );
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
  map.on("click", "pois", (e: any) => {
    const id = e.features?.[0]?.properties?.id;
    const p = id !== undefined ? poiById.get(Number(id)) : undefined;
    if (p && poiCb) poiCb(p);
  });
  map.on("mouseenter", "pois", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "pois", () => (map.getCanvas().style.cursor = ""));

  return {
    map,
    setStyle(style) { map.setStyle(style); },
    setRoute(line) { state.route = line; redraw(); },
    setWaypoints(pts) { state.waypoints = pts; redraw(); },
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
  };
}

export { ONLINE_STYLE };
