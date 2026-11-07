#!/usr/bin/env python3
"""Baut für ein Testgebiet außerhalb Schwedens ein Bodenraster im NMD-Format.

build_camp.py erwartet die schwedische Marktäckedata (NMD, 10 m, EPSG:3006). Die gibt es
nur für Schweden. Für Testgebiete (z.B. in Deutschland, "als ob dort Jedermannsrecht gälte")
wird stattdessen ESA WorldCover 2021 (10 m, CC BY 4.0) gelesen, auf NMD-Klassen umgeschlüsselt
und in SWEREF 99 TM umprojiziert. Gebäude aus OpenStreetMap werden als NMD-Klasse 51
eingebrannt, weil WorldCover nur grobe "bebaute Fläche" kennt (einzelne Höfe fehlen oft).

SWEREF 99 TM außerhalb Schwedens: in Deutschland (5-9 Grad westlich des Mittelmeridians)
liegt der Maßstabsfehler bei 0,1-0,3 %, für 10-m-Raster ohne Belang.

Aufruf: prep_worldcover.py --bbox W,S,E,N --osm gebiet.geojsonseq --out landcover.tif
"""
import argparse
import json
import math
import sys

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
import shapely
from shapely.geometry import shape
from pyproj import Transformer

WC_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
RES = 10.0
BUF = 2000  # Meter Rand (build_camp rechnet Kacheln mit Puffer über die Box hinaus)

# WorldCover -> NMD-Klasse (siehe build_camp.py)
LUT = {
    10: 113,  # Baumbestand (Nadel/Laub unbekannt) -> Mischwald auf festem Boden
    20: 42,   # Gebüsch -> offene Vegetation
    30: 42,   # Grasland -> offene Vegetation (Wiesen/Weiden schließt OSM aus, wenn so erfasst)
    40: 3,    # Acker
    50: 51,   # bebaute Fläche -> Gebäude
    60: 41,   # kahl/spärlich bewachsen -> sonstiges
    70: 41,   # Schnee/Eis
    80: 61,   # Wasser
    90: 2,    # Feuchtgebiet -> Moor
    95: 2,    # Mangroven
    100: 42,  # Moos/Flechten -> offene Vegetation
}


def tiles_for(w, s, e, n):
    out = []
    for lat in range(math.floor(s / 3) * 3, math.ceil(n / 3) * 3, 3):
        for lon in range(math.floor(w / 3) * 3, math.ceil(e / 3) * 3, 3):
            ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
            ew = f"E{lon:03d}" if lon >= 0 else f"W{-lon:03d}"
            out.append(ns + ew)
    return out


def load_osm_layers(path, to3006, probes=()):
    """Gebäude und Ackerflächen (landuse=farmland) aus OSM; druckt Flächen an Prüfpunkten."""
    houses, farmland = [], []
    pts = [(lat, lon, shapely.Point(*to3006.transform(lon, lat))) for lat, lon in probes]
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            feat = json.loads(line)
            p = feat.get("properties") or {}
            b = p.get("building")
            is_house = b and b not in ("no", "roof", "ruins", "construction")
            is_farm = p.get("landuse") == "farmland"
            if not (is_house or is_farm or pts) or not feat.get("geometry"):
                continue
            try:
                g = shape(feat["geometry"])
            except Exception:
                continue
            g = shapely.transform(g, lambda c: np.column_stack(to3006.transform(c[:, 0], c[:, 1])))
            if is_house:
                houses.append(g)
            if is_farm and g.geom_type in ("Polygon", "MultiPolygon"):
                farmland.append(g)
            for lat, lon, pt in pts:
                if g.geom_type in ("Polygon", "MultiPolygon") and g.distance(pt) <= 60:
                    keep = {k: v for k, v in p.items() if k in ("landuse", "natural", "leisure", "landcover", "meadow", "crop", "name", "access", "@id", "building", "highway")}
                    if keep and not keep.keys() <= {"@id", "name"}:
                        where = "enthält Punkt" if g.contains(pt) else f"{g.distance(pt):.0f} m"
                        print(f"  Prüfpunkt {lat},{lon}: {where}: {keep}", file=sys.stderr)
    return houses, farmland


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--osm", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--probe", action="append", default=[], help="lat,lon: OSM-Flächen dort ausgeben")
    a = ap.parse_args()
    w, s, e, n = map(float, a.bbox.split(","))
    to3006 = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    xs, ys = to3006.transform([w, w, e, e, (w + e) / 2, (w + e) / 2], [s, n, s, n, s, n])
    x0 = math.floor((min(xs) - BUF) / 1000) * 1000
    y0 = math.floor((min(ys) - BUF) / 1000) * 1000
    x1 = math.ceil((max(xs) + BUF) / 1000) * 1000
    y1 = math.ceil((max(ys) + BUF) / 1000) * 1000
    W, H = int((x1 - x0) / RES), int((y1 - y0) / RES)
    tr = from_origin(x0, y1, RES, RES)
    print(f"Gebiet {a.bbox}: SWEREF {x0},{y0} - {x1},{y1} ({W} x {H} Pixel)", file=sys.stderr)

    wc = np.zeros((H, W), np.uint8)
    for t in tiles_for(w - 0.1, s - 0.1, e + 0.1, n + 0.1):
        url = "/vsicurl/" + WC_URL.format(tile=t)
        try:
            src = rasterio.open(url)
        except Exception as ex:  # noqa: BLE001
            print(f"  WorldCover {t}: fehlt ({ex})", file=sys.stderr)
            continue
        with src, WarpedVRT(src, crs="EPSG:3006", transform=tr, width=W, height=H,
                            resampling=Resampling.nearest, nodata=0) as vrt:
            part = vrt.read(1)
        wc = np.where(part > 0, part, wc)
        print(f"  WorldCover {t}: {int((part > 0).sum())} Pixel", file=sys.stderr)
    if not wc.any():
        sys.exit("keine WorldCover-Daten im Gebiet")

    nmd = np.zeros((H, W), np.uint8)
    for k, v in LUT.items():
        nmd[wc == k] = v
    hist = {k: round(float((wc == k).mean()) * 100, 1) for k in LUT if (wc == k).any()}
    print(f"  WorldCover-Anteile (%): {hist}", file=sys.stderr)

    probes = [tuple(map(float, p.split(","))) for p in a.probe]
    houses, farmland = load_osm_layers(a.osm, to3006, probes)
    # WorldCover verwechselt in Mitteleuropa oft Wiesen mit Acker. Wo OSM Ackerflächen
    # erfasst hat, gilt nur OSM: Acker = landuse=farmland, übriges "Acker" wird Grasland.
    if len(farmland) >= 20:
        fm = rasterize(((g, 1) for g in farmland), out_shape=(H, W), transform=tr, dtype="uint8").astype(bool)
        moved = (nmd == 3) & ~fm
        nmd[moved] = 42
        nmd[fm & np.isin(nmd, [42, 3])] = 3
        print(f"  OSM-Ackerflächen: {len(farmland)}, {moved.mean() * 100:.1f} % von Acker zu Grasland", file=sys.stderr)
    if houses:
        m = rasterize(((g, 1) for g in houses), out_shape=(H, W), transform=tr, all_touched=True, dtype="uint8")
        nmd[m.astype(bool)] = 51
    print(f"  OSM-Gebäude: {len(houses)}", file=sys.stderr)

    with rasterio.open(a.out, "w", driver="GTiff", width=W, height=H, count=1, dtype="uint8",
                       crs="EPSG:3006", transform=tr, nodata=0, compress="deflate", tiled=True) as dst:
        dst.write(nmd, 1)
    print(f"  geschrieben: {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
