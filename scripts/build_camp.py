#!/usr/bin/env python3
"""Berechnet Zeltplatz-Kandidaten (Wildzelten nach Allemansrätten) für eine Region.

Datenquellen (alle offen, ohne Anmeldung):
  * Nationella Marktäckedata 2023 (NMD, Naturvårdsverket, CC0), 10-m-Raster in SWEREF 99 TM.
    Liefert Untergrund (Wald auf festem Boden, Moor, Acker, Fels), Wasser und Gebäude.
  * FABDEM (Univ. Bristol, CC BY-NC-SA 4.0): Copernicus GLO-30 ohne Bäume und Gebäude, 30 m, für die
    Hangneigung (ersatzweise Copernicus GLO-30, das die Baumkronen mitmisst).
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

Mit --grid schreibt "region" zusätzlich eine Eignungskarte (50-m-Raster in WGS84) für
"Punkt prüfen" in der App. Format (eignung-<id>.bin):
  b"EIG1", uint32 LE Header-Länge, Header-JSON {"w","n","dlon","dlat","nx","ny","cell","v"},
  danach zlib-komprimiert ny*nx uint16 LE, Zeile 0 = Norden. Bits je Zelle (GRID_BITS):
  0-2 Untergrund, 3-5 Hausabstand, 6-7 Neigung, 8-9 Weg, 10-11 Wasser,
  12 Schutzgebiet, 13 Nutzfläche/Moor/Acker zu nah, 14 große Straße < 150 m, 15 alle Regeln erfüllt.
"""
import argparse
import datetime
import json
import math
import multiprocessing as mp
import struct
import sys
import zlib

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

GRID_CELL = 50  # Meter


def bucket(v, edges):
    """Index des ersten Grenzwerts, der größer ist (np.digitize)."""
    return np.digitize(v, edges).astype(np.uint16)


def encode_codes(nmd, d_house, slope, d_acc, d_road, d_water, d_wet, d_arable, excl, res, d_major, cand):
    g = np.full(nmd.shape, 7, np.uint16)  # 7 = bebaut/Fels/Kahlschlag/sonstiges
    g[np.isin(nmd, WATER + [0])] = 0
    g[nmd == 111] = 1
    g[np.isin(nmd, [112, 113, 114])] = 2
    g[np.isin(nmd, [115, 116, 117])] = 3
    g[nmd == OPEN_VEG] = 4
    g[np.isin(nmd, WET)] = 5
    g[np.isin(nmd, ARABLE)] = 6
    house = bucket(d_house, [50, 100, 150, 200, 300, 500, 1000])
    slp = bucket(slope, [3, 6, 10])
    way = np.where(d_road < MIN_ACCESS, 0, np.where(d_acc <= 120, 1, np.where(d_acc <= MAX_ACCESS, 2, 3))).astype(np.uint16)
    wat = bucket(d_water, [MIN_WATER, 150, 400])
    near_bad = excl | (d_wet < MIN_WET) | (d_arable < MIN_ARABLE)
    return (g | house << 3 | slp << 6 | way << 8 | wat << 10 | res.astype(np.uint16) << 12
            | near_bad.astype(np.uint16) << 13 | (d_major < MIN_MAJOR).astype(np.uint16) << 14
            | cand.astype(np.uint16) << 15)


def sample_grid(code, score, bx0, by1, x0, y0, b):
    """Rasterzellen (WGS84-Gitter der Region), deren Mitte im inneren Kachelbereich liegt.

    Je Zelle wird im 5x5-Fenster (50 m) das Pixel mit der besten Bewertung genommen.
    """
    gw, gn, dlon, dlat = G["grid"]
    to4326, to3006 = G["to4326"], G["to3006"]
    lons, lats = to4326.transform([x0, x0, x0 + TILE, x0 + TILE], [y0, y0 + TILE, y0, y0 + TILE])
    j0, j1 = int((min(lons) - gw) / dlon) - 1, int((max(lons) - gw) / dlon) + 2
    i0, i1 = int((gn - max(lats)) / dlat) - 1, int((gn - min(lats)) / dlat) + 2
    j0, i0 = max(j0, 0), max(i0, 0)
    if j1 <= j0 or i1 <= i0:
        return None
    jj, ii = np.meshgrid(np.arange(j0, j1), np.arange(i0, i1))
    clon = gw + (jj + 0.5) * dlon
    clat = gn - (ii + 0.5) * dlat
    x, y = to3006.transform(clon.ravel(), clat.ravel())
    x, y = np.asarray(x), np.asarray(y)
    inside = (x >= x0) & (x < x0 + TILE) & (y >= y0) & (y < y0 + TILE)
    if not inside.any():
        return None
    x, y = x[inside], y[inside]
    c = ((x - bx0) / RES).astype(int)
    r = ((by1 - y) / RES).astype(int)
    best_s = np.full(len(r), -1e9)
    best_c = np.zeros(len(r), np.uint16)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            rr, cc = r + dy, c + dx
            sv = score[rr, cc]
            take = sv > best_s
            best_s = np.where(take, sv, best_s)
            best_c = np.where(take, code[rr, cc], best_c)
    # ohne Kandidat im Fenster: Mittelpixel (zeigt den Grund am Punkt selbst)
    none = best_s < 0
    best_c[none] = code[r[none], c[none]]
    return ii.ravel()[inside].astype(np.int32), jj.ravel()[inside].astype(np.int32), best_c


def write_grid(path, grid, gw, gn, dlon, dlat):
    ny, nx = grid.shape
    header = json.dumps({"v": 1, "w": gw, "n": gn, "dlon": dlon, "dlat": dlat, "nx": nx, "ny": ny,
                         "cell": GRID_CELL}).encode()
    with open(path, "wb") as f:
        f.write(b"EIG1" + struct.pack("<I", len(header)) + header)
        f.write(zlib.compress(grid.astype("<u2").tobytes(), 9))



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
        return [], None
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

    if G.get("grid"):
        code = encode_codes(nmd, d_house, slope, d_acc, d_road, d_water, d_wet, d_arable,
                            excl, res, d_major, cand)
        samples = sample_grid(code, score, bx0, by1, x0, y0, b)
    else:
        samples = None

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
    return out, samples


def init_worker(nmd_path, dem_path, osm, grid=None):
    G["nmd"] = rasterio.open(nmd_path)
    G["dem"] = rasterio.open(dem_path)
    G["osm"] = osm
    G["grid"] = grid
    G["to4326"] = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)
    G["to3006"] = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)


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
    grid_def, grid = None, None
    if a.grid:
        dlat = GRID_CELL / 111_320
        dlon = GRID_CELL / (111_320 * math.cos(math.radians((s + n) / 2)))
        nx, ny = math.ceil((e - w) / dlon), math.ceil((n - s) / dlat)
        grid_def = (w, n, dlon, dlat)
        grid = np.zeros((ny, nx), np.uint16)  # 0 = Wasser/keine Daten
        print(f"  Eignungskarte {nx} x {ny} Zellen", file=sys.stderr)
    init_worker(a.nmd, a.dem, osm, grid_def)  # für fork: Daten im Elternprozess vorbereiten
    pts = []
    ctx = mp.get_context("fork")
    with ctx.Pool(a.jobs, initializer=init_worker, initargs=(a.nmd, a.dem, osm, grid_def)) as pool:
        for i, (res, samples) in enumerate(pool.imap_unordered(process_tile, origins, chunksize=2)):
            pts.extend(res)
            if samples is not None and grid is not None:
                si, sj, sc = samples
                ok = (si < grid.shape[0]) & (sj < grid.shape[1])
                grid[si[ok], sj[ok]] = sc[ok]
            if i % 50 == 0:
                print(f"  {i}/{len(origins)} Kacheln, {len(pts)} Punkte", file=sys.stderr)
    # nur Punkte innerhalb der Region (Kacheln ragen über die Box hinaus)
    pts = [p for p in pts if s <= p[1] / 1e5 <= n and w <= p[2] / 1e5 <= e]
    with open(a.out, "w") as f:
        json.dump(pts, f, separators=(",", ":"))
    print(f"  {len(pts)} Kandidaten", file=sys.stderr)
    if grid is not None:
        write_grid(a.grid, grid, *grid_def)
        import os
        print(f"  Eignungskarte {a.grid}: {os.path.getsize(a.grid) / 1e6:.1f} MB, "
              f"{int((grid >> 15).sum())} geeignete Zellen", file=sys.stderr)


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
        "source": "NMD Naturvårdsverket (CC0), FABDEM (Univ. Bristol, CC BY-NC-SA 4.0) auf Basis Copernicus DEM GLO-30 (© DLR/Airbus, ESA), © OpenStreetMap-Mitwirkende (ODbL)",
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
    r.add_argument("--grid", help="Eignungskarte schreiben (eignung-<id>.bin)")
    r.add_argument("--jobs", type=int, default=mp.cpu_count())
    m = sub.add_parser("merge")
    m.add_argument("--out", required=True)
    m.add_argument("inputs", nargs="+")
    a = ap.parse_args()
    cmd_region(a) if a.cmd == "region" else cmd_merge(a)


if __name__ == "__main__":
    main()
