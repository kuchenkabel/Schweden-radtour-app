#!/usr/bin/env python3
"""Berechnet Zeltplatz-Kandidaten (Wildzelten nach Allemansrätten) für eine Region.

Datenquellen (alle offen, ohne Anmeldung):
  * Nationella Marktäckedata 2023 (NMD, Naturvårdsverket, CC0), 10-m-Raster in SWEREF 99 TM.
    Liefert Untergrund (Wald auf festem Boden, Moor, Acker, Fels), Wasser und Gebäude.
  * Copernicus DEM GLO-30 (ESA), Höhenmodell 30 m, für die Hangneigung.
  * OpenStreetMap: Wege (Zufahrt), Straßen (Abstand), Nutzflächen und Schutzgebiete.

Regeln (Faustregeln zum Jedermannsrecht, bewusst vorsichtig):
  * mindestens 200 m bis zum nächsten Gebäude (außer Sicht von Wohnhäusern)
  * nicht auf Acker, Wiese, Weide, Garten, Moor; Abstand zu Acker und Moor
  * Wald auf festem Boden oder offenes Grasland/Heide
  * Neigung höchstens 6 Grad (geglättet, Höhenmodell ist grob)
  * Weg/Zufahrt 25 bis 300 m entfernt, mindestens 25 m von jedem Weg, 150 m von größeren Straßen
  * in Naturschutzgebieten erlaubt, aber markiert (Vorschriften unterscheiden sich)
Pro 1-km-Zelle wird höchstens der beste Punkt behalten.

Aufrufe:
  build_camp.py region --bbox W,S,E,N --nmd nmd.tif --dem dem.vrt --osm region.geojsonseq --out region.json
  build_camp.py merge --out camp-sweden.json region1.json region2.json ...
"""
import argparse
import datetime
import json
import multiprocessing as mp
import sys

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds
from scipy import ndimage
import shapely
from shapely.geometry import shape, box
from pyproj import Transformer

RES = 10.0          # Meter je Pixel
TILE = 10_000       # Kachelgröße in Metern (innerer Bereich)
BUF = 700           # Rand für Abstandsberechnungen
CELL = 1000         # Ausdünnung: ein Punkt je km²
FAR = 9999

# NMD-Klassen
FOREST_FIRM = {111: 1.0, 113: 0.85, 114: 0.8, 115: 0.75, 116: 0.7, 117: 0.7, 112: 0.55}
OPEN_VEG = 42
OPEN_VEG_Q = 0.5
WET = [2, 121, 122, 123, 124, 125, 126, 127, 128]
ARABLE = [3]
BUILDING = [51]
ROADLIKE = [52, 53, 54]
WATER = [61, 62]

# Regeln
MIN_HOUSE = 200
MAX_SLOPE = 6.0
MIN_ACCESS, MAX_ACCESS = 25, 300
MIN_MAJOR = 150
MIN_WET = 30
MIN_ARABLE = 30
MIN_WATER = 30
MIN_SCORE = 55

ACCESS_WAYS = {"track", "cycleway", "path", "bridleway", "footway", "unclassified"}
MAJOR_WAYS = {"motorway", "trunk", "primary", "secondary", "tertiary",
              "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
EXCLUDE_LANDUSE = {"residential", "farmyard", "farmland", "meadow", "orchard", "allotments", "cemetery",
                   "military", "quarry", "industrial", "commercial", "retail", "construction", "landfill",
                   "railway", "garages", "vineyard", "plant_nursery", "grass", "recreation_ground", "animal_keeping"}
EXCLUDE_LEISURE = {"golf_course", "park", "pitch", "garden", "sports_centre", "playground", "marina",
                   "stadium", "track", "dog_park", "horse_riding", "resort", "beach_resort"}


def classify_osm(t):
    """Gibt (Klasse) für ein OSM-Objekt zurück: access/road/major/exclude/reserve oder None."""
    hw = t.get("highway")
    out = []
    if hw:
        if hw in MAJOR_WAYS:
            out.append("major")
        out.append("road")
        if hw in ACCESS_WAYS and t.get("access") not in ("private", "no") and t.get("bicycle") != "no":
            out.append("access")
    if (t.get("landuse") in EXCLUDE_LANDUSE or t.get("leisure") in EXCLUDE_LEISURE
            or t.get("natural") == "wetland" or t.get("tourism") in ("camp_site", "caravan_site")
            or t.get("amenity") == "parking" or "military" in t or t.get("aeroway") == "aerodrome"):
        out.append("exclude")
    if t.get("leisure") == "nature_reserve" or t.get("boundary") in ("national_park", "protected_area"):
        out.append("reserve")
    return out


def load_osm(path, bounds3006):
    to3006 = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    groups = {k: [] for k in ("access", "road", "major", "exclude", "reserve")}
    clip = box(*bounds3006)
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            feat = json.loads(line)
            cls = classify_osm(feat.get("properties") or {})
            if not cls or not feat.get("geometry"):
                continue
            try:
                g = shape(feat["geometry"])
            except Exception:
                continue
            g = shapely.transform(g, lambda c: np.column_stack(to3006.transform(c[:, 0], c[:, 1])))
            if not g.is_valid:
                g = g.buffer(0) if g.geom_type in ("Polygon", "MultiPolygon") else g
            if not g.intersects(clip):
                continue
            for c in cls:
                # Flächen nur für exclude/reserve, Linien (auch Umrisse) für Wege
                if c in ("exclude", "reserve") and g.geom_type not in ("Polygon", "MultiPolygon"):
                    continue
                groups[c].append(g)
    trees = {k: (shapely.STRtree(v), v) for k, v in groups.items()}
    for k, v in groups.items():
        print(f"  OSM {k:8s} {len(v):8d}", file=sys.stderr)
    return trees


def raster_of(trees, key, bounds, shape_, transform):
    tree, geoms = trees[key]
    idx = tree.query(box(*bounds))
    if len(idx) == 0:
        return np.zeros(shape_, bool)
    return rasterize(((geoms[i], 1) for i in idx), out_shape=shape_, transform=transform,
                     all_touched=True, dtype="uint8").astype(bool)


def dist(mask):
    """Abstand in Metern zum nächsten True-Pixel."""
    if not mask.any():
        return np.full(mask.shape, float(FAR), np.float32)
    return (ndimage.distance_transform_edt(~mask) * RES).astype(np.float32)


G = {}


def process_tile(origin):
    x0, y0 = origin
    bx0, by0, bx1, by1 = x0 - BUF, y0 - BUF, x0 + TILE + BUF, y0 + TILE + BUF
    W = H = int((TILE + 2 * BUF) / RES)
    tr = from_origin(bx0, by1, RES, RES)
    nmd_src = G["nmd"]
    win = from_bounds(bx0, by0, bx1, by1, transform=nmd_src.transform)
    nmd = nmd_src.read(1, window=win, out_shape=(H, W), boundless=True, fill_value=0,
                       resampling=Resampling.nearest)
    b = int(BUF / RES)
    inner = nmd[b:-b, b:-b]
    land = ~np.isin(inner, WATER + [0])
    if land.mean() < 0.05:
        return []
    with WarpedVRT(G["dem"], crs="EPSG:3006", transform=tr, width=W, height=H,
                   resampling=Resampling.bilinear) as vrt:
        dem = vrt.read(1).astype(np.float32)
    dem = ndimage.gaussian_filter(dem, sigma=3)
    gy, gx = np.gradient(dem, RES)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    slope = ndimage.maximum_filter(slope, size=3)

    bounds = (bx0, by0, bx1, by1)
    trees = G["osm"]
    acc = raster_of(trees, "access", bounds, (H, W), tr)
    road = raster_of(trees, "road", bounds, (H, W), tr)
    major = raster_of(trees, "major", bounds, (H, W), tr)
    excl = raster_of(trees, "exclude", bounds, (H, W), tr)
    res = raster_of(trees, "reserve", bounds, (H, W), tr)

    d_house = dist(np.isin(nmd, BUILDING))
    d_water = dist(np.isin(nmd, WATER))
    d_wet = dist(np.isin(nmd, WET))
    d_arable = dist(np.isin(nmd, ARABLE))
    d_acc = dist(acc)
    d_road = dist(road | np.isin(nmd, ROADLIKE))
    d_major = dist(major)

    ground_q = np.zeros(nmd.shape, np.float32)
    for code, q in FOREST_FIRM.items():
        ground_q[nmd == code] = q
    ground_q[nmd == OPEN_VEG] = OPEN_VEG_Q

    cand = ((ground_q > 0) & ~excl
            & (d_house >= MIN_HOUSE) & (slope <= MAX_SLOPE)
            & (d_acc >= MIN_ACCESS) & (d_acc <= MAX_ACCESS) & (d_road >= MIN_ACCESS)
            & (d_major >= MIN_MAJOR) & (d_wet >= MIN_WET) & (d_arable >= MIN_ARABLE)
            & (d_water >= MIN_WATER))
    # ebene, zusammenhängende Fläche von mind. 30 x 30 m
    cand = ndimage.binary_erosion(cand, structure=np.ones((3, 3), bool))

    s_house = np.clip((d_house - MIN_HOUSE) / 400, 0, 1)
    s_slope = np.clip(1 - slope / MAX_SLOPE, 0, 1)
    s_water = np.where(d_water <= 400, 1 - np.clip(d_water - 50, 0, None) / 350, 0)
    s_acc = np.where(d_acc <= 120, 1.0, 1 - 0.7 * (d_acc - 120) / (MAX_ACCESS - 120))
    score = 35 * s_house + 20 * s_slope + 15 * s_water + 15 * s_acc + 15 * ground_q - 10 * res
    score = np.where(cand, score, -1)

    sc = score[b:-b, b:-b]
    n = TILE // CELL
    k = CELL // int(RES)
    blocks = sc.reshape(n, k, n, k).transpose(0, 2, 1, 3).reshape(n, n, k * k)
    best = blocks.argmax(axis=2)
    best_val = np.take_along_axis(blocks, best[..., None], axis=2)[..., 0]
    to4326 = G["to4326"]
    out = []
    for i in range(n):
        for j in range(n):
            v = best_val[i, j]
            if v < MIN_SCORE:
                continue
            r = b + i * k + best[i, j] // k
            c = b + j * k + best[i, j] % k
            x = bx0 + (c + 0.5) * RES
            y = by1 - (r + 0.5) * RES
            lon, lat = to4326.transform(x, y)
            dw = int(d_water[r, c])
            out.append([
                f"{int(x // CELL)}:{int(y // CELL)}",
                round(lat * 1e5), round(lon * 1e5), int(round(v)),
                int(min(d_house[r, c], FAR)), int(round(slope[r, c] * 10)),
                dw if dw <= 2000 else FAR, int(d_acc[r, c]), int(nmd[r, c]), int(res[r, c]),
            ])
    return out


def init_worker(nmd_path, dem_path, osm):
    G["nmd"] = rasterio.open(nmd_path)
    G["dem"] = rasterio.open(dem_path)
    G["osm"] = osm
    G["to4326"] = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)


def cmd_region(a):
    w, s, e, n = map(float, a.bbox.split(","))
    to3006 = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    xs, ys = to3006.transform([w, w, e, e], [s, n, s, n])
    x0 = int(min(xs) // TILE * TILE)
    y0 = int(min(ys) // TILE * TILE)
    x1 = int(-(-max(xs) // TILE) * TILE)
    y1 = int(-(-max(ys) // TILE) * TILE)
    print(f"Region {a.bbox}: SWEREF {x0},{y0} - {x1},{y1}", file=sys.stderr)
    osm = load_osm(a.osm, (x0 - BUF, y0 - BUF, x1 + BUF, y1 + BUF))
    origins = [(x, y) for x in range(x0, x1, TILE) for y in range(y0, y1, TILE)]
    print(f"  {len(origins)} Kacheln", file=sys.stderr)
    init_worker(a.nmd, a.dem, osm)  # für fork: Daten im Elternprozess vorbereiten
    pts = []
    ctx = mp.get_context("fork")
    with ctx.Pool(a.jobs, initializer=init_worker, initargs=(a.nmd, a.dem, osm)) as pool:
        for i, res in enumerate(pool.imap_unordered(process_tile, origins, chunksize=2)):
            pts.extend(res)
            if i % 50 == 0:
                print(f"  {i}/{len(origins)} Kacheln, {len(pts)} Punkte", file=sys.stderr)
    # nur Punkte innerhalb der Region (Kacheln ragen über die Box hinaus)
    pts = [p for p in pts if s <= p[1] / 1e5 <= n and w <= p[2] / 1e5 <= e]
    with open(a.out, "w") as f:
        json.dump(pts, f, separators=(",", ":"))
    print(f"  {len(pts)} Kandidaten", file=sys.stderr)


def cmd_merge(a):
    best = {}
    for path in a.inputs:
        for p in json.load(open(path)):
            if p[0] not in best or p[3] > best[p[0]][3]:
                best[p[0]] = p
    pts = sorted((p[1:] for p in best.values()), key=lambda p: (p[0], p[1]))
    out = {
        "v": 1,
        "generated": datetime.date.today().isoformat(),
        "source": "NMD Naturvårdsverket (CC0), Copernicus DEM GLO-30 (© DLR/Airbus, ESA), © OpenStreetMap-Mitwirkende (ODbL)",
        "fields": ["lat", "lon", "score", "house", "slope10", "water", "access", "ground", "res"],
        "pts": pts,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(pts)} Zeltplatz-Kandidaten gesamt")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("region")
    r.add_argument("--bbox", required=True)
    r.add_argument("--nmd", required=True)
    r.add_argument("--dem", required=True)
    r.add_argument("--osm", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--jobs", type=int, default=mp.cpu_count())
    m = sub.add_parser("merge")
    m.add_argument("--out", required=True)
    m.add_argument("inputs", nargs="+")
    a = ap.parse_args()
    cmd_region(a) if a.cmd == "region" else cmd_merge(a)


if __name__ == "__main__":
    main()
