#!/usr/bin/env python3
"""Druckbare Posterkarte Südschweden (A3-Kacheln + Übersichtsblatt).

Eingaben (Release "poster-data", siehe .github/workflows/poster-data.yml):
  osm.gpkg   OSM-Ausschnitt (Straßen, Wasser, Wald, Orte, Radrouten …)
  sea.gpkg   Meeresflächen
  dem50.tif  Höhenmodell 50 m in SWEREF99 TM (EPSG:3006)
und optional eine GPX-Datei mit Track + Schlafplätzen (wpt), standardmäßig ohne Route
(die Karte ist zum händischen Einzeichnen gedacht).

Aufruf (pip install geopandas pyogrio rasterio matplotlib img2pdf):
  python3 scripts/poster/render_poster.py --data DIR --out OUT.pdf [--gpx ROUTE.gpx] [--sheets 0,3]

Projektion SWEREF99 TM (EPSG:3006), Maßstab 1:200 000, 2 x 4 Blätter A3 hochkant.
Das 10-km-Gitter entspricht den SWEREF-Koordinaten (Spalten A…, Zeilen 1…).
"""
import argparse
import math
import os
import re
import sys

import geopandas as gpd
import matplotlib
import numpy as np
import rasterio
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point, box
from shapely.geometry.polygon import orient

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import patheffects as pe  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
from matplotlib.patches import Circle, FancyBboxPatch, PathPatch, Rectangle  # noqa: E402
from matplotlib.path import Path  # noqa: E402

# ---------------------------------------------------------------- Layout
SCALE = 200_000
M_PER_MM = SCALE / 1000          # 200 m Natur pro mm Papier
COLS, ROWS = 2, 4
SHEET_W, SHEET_H = 275, 390      # Kartenfläche je Blatt in mm
PAGE_W, PAGE_H = 297, 420        # A3 hochkant
OFF_L, OFF_T = 11, 12            # Lage der Kartenfläche auf dem Blatt (mm)
X0 = 300_000
YTOP = 6_440_000
XW = COLS * SHEET_W * M_PER_MM   # 110 km
YH = ROWS * SHEET_H * M_PER_MM   # 320 km
X1, Y0 = X0 + XW, YTOP - YH
GRID = 10_000
DPI = 300
PT_PER_MM = 72 / 25.4

TO_M = Transformer.from_crs(4326, 3006, always_xy=True)
TO_LL = Transformer.from_crs(3006, 4326, always_xy=True)

FONT = "DejaVu Sans"
for cand in ("Inter", "Carlito", "DejaVu Sans"):
    if any(cand == f.name for f in matplotlib.font_manager.fontManager.ttflist):
        FONT = cand
        break
plt.rcParams["font.family"] = FONT

# ---------------------------------------------------------------- Farben
C = dict(
    land="#f5f2e6", sea="#a8d1ee", water="#a8d1ee", water_edge="#5b9bd0",
    forest="#c9e2b1", wetland="#d9e8d6", heath="#e6ecc9", beach="#f6e7b0",
    urban="#ead8cc", industrial="#ddd6dc", protected="#3c8a3c",
    grid="#1f5f8f", route="#d7191c", cycle_n="#8e3fb0", cycle_r="#b67fd3",
    rail="#3a3a3a", ferry="#2f6db5", text="#222222",
)
ROADS = [  # (highway-Werte, Hüllfarbe, Füllfarbe, Hüllbreite mm, Füllbreite mm)
    (("unclassified",), "#9b9b9b", "#ffffff", 0.48, 0.28),
    (("tertiary", "tertiary_link"), "#7c7c7c", "#ffffff", 0.70, 0.46),
    (("secondary", "secondary_link"), "#9a8136", "#fbe08a", 0.85, 0.60),
    (("primary", "primary_link"), "#a8692a", "#f6b45a", 0.98, 0.70),
    (("trunk", "trunk_link"), "#a5512b", "#f08e4f", 1.10, 0.80),
    (("motorway", "motorway_link"), "#7f2618", "#e2573b", 1.25, 0.95),
]


def lw(mm):
    """mm -> Linienbreite in pt."""
    return mm * PT_PER_MM


def halo(w=2.2, c="white"):
    return [pe.withStroke(linewidth=w, foreground=c)]


def tags(s):
    """GDAL-'other_tags' (hstore) als dict."""
    if not isinstance(s, str):
        return {}
    return dict(re.findall(r'"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"', s))


# ---------------------------------------------------------------- Daten
class Data:
    def __init__(self, ddir, gpx):
        ll = TO_LL.transform_bounds(X0 - 5000, Y0 - 5000, X1 + 5000, YTOP + 5000)
        self.bbox_ll = ll
        g = os.path.join(ddir, "osm.gpkg")

        def read(layer, **kw):
            df = gpd.read_file(g, layer=layer, bbox=ll, engine="pyogrio", **kw)
            df = df[df.geometry.notna()].to_crs(3006)
            return df

        print("lese Flächen …", flush=True)
        mp = read("multipolygons")
        ot = mp["other_tags"].map(tags)
        mp["water_t"] = ot.map(lambda t: t.get("water", ""))
        mp["geometry"] = mp.geometry.simplify(12)
        nat, lu = mp["natural"].fillna(""), mp["landuse"].fillna("")
        self.forest = mp[(nat == "wood") | (lu == "forest")]
        self.water = mp[nat == "water"]
        self.wetland = mp[nat == "wetland"]
        self.heath = mp[nat.isin(["heath", "scrub", "bare_rock"])]
        self.beach = mp[nat == "beach"]
        self.urban = mp[lu.isin(["residential", "commercial", "retail"])]
        self.industrial = mp[lu.isin(["industrial", "quarry"])]
        bd = mp["boundary"].fillna("")
        self.protected = mp[bd.isin(["national_park", "protected_area"]) |
                            (mp["leisure"].fillna("") == "nature_reserve")]
        self.airport = mp[mp["aeroway"].fillna("") == "aerodrome"]

        print("lese Linien …", flush=True)
        ln = read("lines")
        ln["geometry"] = ln.geometry.simplify(8)
        hw = ln["highway"].fillna("")
        self.roads = ln[hw != ""]
        cw = ln[hw == "cycleway"]
        # Radwege innerhalb von Orten weglassen (nur Gewirr), außerhalb zeigen sie Wege neben Straßen
        mid = gpd.GeoDataFrame(geometry=cw.geometry.interpolate(0.5, normalized=True), crs=cw.crs)
        inside = gpd.sjoin(mid, self.urban[["geometry"]], predicate="within", how="inner").index
        self.cycleway = cw[~cw.index.isin(inside)]
        self.rail = ln[ln["railway"].fillna("").isin(["rail", "light_rail"])]
        self.ferry = ln[ln["route"].fillna("") == "ferry"]
        self.rivers = ln[ln["waterway"].fillna("").isin(["river", "canal"])]

        print("lese Radrouten …", flush=True)
        ml = read("multilinestrings")
        ml = ml[ml["route"].fillna("") == "bicycle"].copy()
        ml["net"] = ml["network"].fillna("")
        ml = ml[ml["net"].isin(["icn", "ncn", "rcn"])]
        ml["geometry"] = ml.geometry.simplify(10)
        self.cycle = ml

        print("lese Orte …", flush=True)
        pt = read("points")
        pt = pt[pt["place"].fillna("") != ""].copy()
        pt["pop"] = pt["other_tags"].map(lambda s: tags(s).get("population", "0"))
        pt["pop"] = pd_num(pt["pop"])
        self.places = pt

        print("lese Meer …", flush=True)
        sea = gpd.read_file(os.path.join(ddir, "sea.gpkg"), bbox=ll, engine="pyogrio").to_crs(3006)
        sea["geometry"] = sea.geometry.simplify(12)
        self.sea = sea

        self.dem_path = os.path.join(ddir, "dem50.tif")
        self.track, self.stops, self.cum = None, [], None
        if gpx:
            self.load_route(gpx)

    def load_route(self, gpx):
        s = open(gpx, encoding="utf-8").read()
        pts = [(float(a), float(b)) for a, b in
               re.findall(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)"', s)]
        xs, ys = TO_M.transform([p[1] for p in pts], [p[0] for p in pts])
        xy = np.column_stack([xs, ys])
        self.track = xy
        seg = np.hypot(*np.diff(xy, axis=0).T)
        self.cum = np.concatenate([[0], np.cumsum(seg)])
        wps = []
        for la, lo, name in re.findall(
                r'<wpt lat="([-\d.]+)" lon="([-\d.]+)">\s*<name>([^<]*)</name>', s):
            x, y = TO_M.transform(float(lo), float(la))
            i = int(np.argmin(np.hypot(xy[:, 0] - x, xy[:, 1] - y)))
            name = (name.replace("&amp;", "&").replace(": Zelt (Kandidaten in der App prüfen)",
                                                        " (Zelt)"))
            wps.append(dict(x=x, y=y, i=i, km=self.cum[i] / 1000, name=name))
        wps.sort(key=lambda w: w["i"])
        self.stops = wps


def pd_num(series):
    def f(v):
        try:
            return float(str(v).replace(" ", "").replace(",", ""))
        except ValueError:
            return 0.0
    return series.map(f)


# Ruhetage (Nächte am selben Platz) laut Etappenplan
REST_AT = ("Mölle", "Hagöns", "Sätila")


def stage_days(stops):
    if not stops:
        return [], 0
    """Tagesnummern wie in der App: Etappenende = Schlafplatz von Tag N, Ruhetage mitgezählt."""
    day = 0
    out = []
    for s in stops:
        day += 1
        lab = str(day)
        if any(r in s["name"] for r in REST_AT):
            day += 1
            lab = f"{day - 1}/{day}"
        out.append(lab)
    return out, day + 1


# ---------------------------------------------------------------- Zeichnen
def poly_path(geoms):
    verts, codes = [], []
    for g in geoms:
        if g is None or g.is_empty:
            continue
        parts = getattr(g, "geoms", [g])
        for p in parts:
            if p.geom_type != "Polygon":
                continue
            p = orient(p)
            for ring in [p.exterior, *p.interiors]:
                c = np.asarray(ring.coords)
                if len(c) < 3:
                    continue
                verts.append(c)
                codes.append(np.full(len(c), Path.LINETO, dtype=np.uint8))
                codes[-1][0] = Path.MOVETO
                codes[-1][-1] = Path.CLOSEPOLY
    if not verts:
        return None
    return Path(np.concatenate(verts), np.concatenate(codes))


def draw_polys(ax, df, clip, **kw):
    if df is None or len(df) == 0:
        return
    sub = df.cx[clip[0]:clip[2], clip[1]:clip[3]]
    p = poly_path(sub.geometry.values)
    if p is not None:
        ax.add_patch(PathPatch(p, **kw))


def line_segs(geoms):
    out = []
    for g in geoms:
        if g is None or g.is_empty:
            continue
        for p in getattr(g, "geoms", [g]):
            if p.geom_type == "LineString":
                out.append(np.asarray(p.coords))
            elif p.geom_type == "Polygon":
                out.append(np.asarray(p.exterior.coords))
    return out


def draw_lines(ax, df, clip, color, width_mm, z, **kw):
    if df is None or len(df) == 0:
        return
    sub = df.cx[clip[0]:clip[2], clip[1]:clip[3]]
    segs = line_segs(sub.geometry.values)
    if segs:
        ax.add_collection(LineCollection(segs, colors=color, linewidths=lw(width_mm),
                                         zorder=z, capstyle="round", joinstyle="round", **kw))


def hillshade(dem_path):
    with rasterio.open(dem_path) as src:
        z = src.read(1).astype("float32")
        b = src.bounds
        res = src.res[0]
    z = np.nan_to_num(z, nan=0.0)
    z[z < -50] = 0
    dy, dx = np.gradient(z, res)
    dy = -dy
    slope = np.arctan(np.hypot(dx, dy) * 1.6)        # leicht überhöht: Südschweden ist flach
    aspect = np.arctan2(-dx, dy)
    az, alt = math.radians(315), math.radians(45)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    flat = math.sin(alt)
    dark = np.clip((flat - hs) * 1.5, 0, 0.42)
    light = np.clip((hs - flat) * 1.2, 0, 0.18)
    rgba = np.zeros(z.shape + (4,), dtype="float32")
    rgba[..., 3] = dark
    # Aufhellung auf der Sonnenseite als weißer Anteil
    lmask = light > dark
    rgba[lmask, :3] = 1.0
    rgba[lmask, 3] = light[lmask]
    return rgba, (b.left, b.right, b.bottom, b.top), z


class Labeler:
    """Einfache, gierige Beschriftung ohne Überlappung (in Papier-mm umgerechnet)."""

    def __init__(self):
        self.boxes = []
        self.items = []

    @staticmethod
    def size(text, fs, bold=False):
        w = len(text) * fs * 0.3528 * (0.62 if bold else 0.56) * M_PER_MM
        h = fs * 0.3528 * 1.15 * M_PER_MM
        return w, h

    def free(self, bx):
        x0, y0, x1, y1 = bx
        for a in self.boxes:
            if x0 < a[2] and x1 > a[0] and y0 < a[3] and y1 > a[1]:
                return False
        return True

    def block(self, bx):
        self.boxes.append(bx)

    def place(self, x, y, text, fs, bold=False, dot_r_mm=0.0, offsets=None, force=False, **style):
        w, h = self.size(text, fs, bold)
        d = (dot_r_mm + 0.6) * M_PER_MM
        cands = offsets or [("left", "center", d, 0), ("right", "center", -d, 0),
                            ("center", "bottom", 0, d * 0.8), ("center", "top", 0, -d * 0.8),
                            ("left", "bottom", d * .7, d * .7), ("right", "bottom", -d * .7, d * .7),
                            ("left", "top", d * .7, -d * .7), ("right", "top", -d * .7, -d * .7)]
        for ha, va, ox, oy in cands:
            tx, ty = x + ox, y + oy
            x0 = tx if ha == "left" else (tx - w if ha == "right" else tx - w / 2)
            y0 = ty if va == "bottom" else (ty - h if va == "top" else ty - h / 2)
            bx = (x0, y0, x0 + w, y0 + h)
            if force or self.free(bx):
                self.block(bx)
                self.items.append(dict(x=tx, y=ty, text=text, fs=fs, ha=ha, va=va,
                                       weight="bold" if bold else "normal", **style))
                return True
        return False

    def draw(self, ax, clip):
        for it in self.items:
            if not (clip[0] - 20000 < it["x"] < clip[2] + 20000 and clip[1] - 5000 < it["y"] < clip[3] + 5000):
                continue
            ax.text(it["x"], it["y"], it["text"], fontsize=it["fs"], ha=it["ha"], va=it["va"],
                    fontweight=it["weight"], color=it.get("color", C["text"]),
                    fontstyle=it.get("style", "normal"), rotation=it.get("rot", 0),
                    rotation_mode="anchor", zorder=it.get("z", 60),
                    path_effects=halo(it.get("halo", 2.0), it.get("halo_c", "white")),
                    clip_on=True)


def build_labels(D, days):
    L = Labeler()
    # 1) Etappenmarker blockieren
    for s in D.stops:
        r = 2.8 * M_PER_MM
        L.block((s["x"] - r, s["y"] - r, s["x"] + r, s["y"] + r))
    if D.track is not None:
        # Start / Ziel
        sx, sy = D.track[0]
        ex, ey = D.track[-1]
        for x, y in ((sx, sy), (ex, ey)):
            r = 3.2 * M_PER_MM
            L.block((x - r, y - r, x + r, y + r))
        # 2) Namen der Schlafplätze
        for s, dlab in zip(D.stops, days):
            L.place(s["x"], s["y"], s["name"], 6.2, bold=True, dot_r_mm=2.6, color=C["route"], z=72,
                    halo=2.4)
        L.place(sx, sy, "START", 7.5, bold=True, dot_r_mm=3.0, color=C["route"], z=72)
        L.place(ex, ey, "ZIEL", 7.5, bold=True, dot_r_mm=3.0, color=C["route"], z=72)

    # 3) Meeresnamen (fest)
    for lon, lat, name, fs in ((12.75, 55.83, "Ö r e s u n d", 11), (11.9, 57.05, "K a t t e g a t t", 16),
                               (13.35, 55.27, "O s t s e e", 13), (12.45, 56.10, "Skälderviken", 8)):
        x, y = TO_M.transform(lon, lat)
        L.place(x, y, name, fs, offsets=[("center", "center", 0, 0)], color="#2f6db5", style="italic",
                halo=0, z=55)

    # 4) Orte
    pl = D.places
    order = [("city", 13, True), ("town", 9, True), ("village", 6.3, False), ("hamlet", 4.8, False)]
    for kind, fs, bold in order:
        sub = pl[pl["place"] == kind].sort_values("pop", ascending=False)
        if kind == "town":
            sub = sub.copy()
        for _, r in sub.iterrows():
            nm = r["name"]
            if not isinstance(nm, str) or not nm:
                continue
            g = r.geometry
            f = fs
            if kind == "town" and r["pop"] > 40000:
                f = 10.5
            col = "#111111" if kind in ("city", "town") else "#333333"
            L.place(g.x, g.y, nm, f, bold=bold, dot_r_mm=0.7 if kind in ("village", "hamlet") else 0.9,
                    color=col, z=62, dot=kind)
    # 5) Inseln (nur Namen, kursiv)
    # 6) Seen
    wat = D.water.copy()
    wat["area"] = wat.geometry.area
    wat = wat[(wat["area"] > 2.0e6) & wat["name"].notna()].sort_values("area", ascending=False)
    for _, r in wat.iterrows():
        p = r.geometry.representative_point()
        fs = 6 + min(4, math.log10(r["area"] / 2e6) * 2.5)
        L.place(p.x, p.y, r["name"], fs, offsets=[("center", "center", 0, 0)], color="#1f5a99",
                style="italic", z=58, halo=1.6, halo_c="#cfe6f7")
    # 7) Radrouten-Namen entlang der Linie
    cyc = D.cycle[D.cycle["name"].notna()]
    for _, r in cyc.sort_values("net").iterrows():
        g = r.geometry
        length = g.length
        if length < 8000:
            continue
        nm = r["name"]
        step = 30000
        for f in np.arange(step / 2, length, step):
            p = g.interpolate(f) if g.geom_type == "LineString" else shapely.line_interpolate_point(
                shapely.line_merge(g), f)
            if p.is_empty:
                continue
            q = shapely.line_interpolate_point(shapely.line_merge(g), min(length, f + 1500))
            ang = math.degrees(math.atan2(q.y - p.y, q.x - p.x))
            if ang > 90:
                ang -= 180
            if ang < -90:
                ang += 180
            w, h = L.size(nm, 6, True)
            ca, sa = abs(math.cos(math.radians(ang))), abs(math.sin(math.radians(ang)))
            bw, bh = w * ca + h * sa, w * sa + h * ca
            bx = (p.x - bw / 2, p.y - bh / 2, p.x + bw / 2, p.y + bh / 2)
            if L.free(bx):
                L.block(bx)
                L.items.append(dict(x=p.x, y=p.y, text=nm, fs=6, ha="center", va="center",
                                    weight="bold", color=C["cycle_n"], rot=ang, z=61, halo=2.0))
    return L


def draw_map(ax, D, clip, L, shade, days, overview=False):
    ax.set_facecolor(C["land"])
    ax.add_patch(Rectangle((clip[0], clip[1]), clip[2] - clip[0], clip[3] - clip[1],
                           facecolor=C["land"], zorder=0))
    k = 2.5 if overview else 1.0     # Übersicht: Linien schmaler
    draw_polys(ax, D.urban, clip, facecolor=C["urban"], edgecolor="none", zorder=2)
    draw_polys(ax, D.industrial, clip, facecolor=C["industrial"], edgecolor="none", zorder=2)
    draw_polys(ax, D.heath, clip, facecolor=C["heath"], edgecolor="none", zorder=2)
    draw_polys(ax, D.forest, clip, facecolor=C["forest"], edgecolor="none", zorder=3)
    draw_polys(ax, D.wetland, clip, facecolor=C["wetland"], edgecolor="#8fb39a", hatch="--",
               linewidth=0, zorder=3)
    draw_polys(ax, D.beach, clip, facecolor=C["beach"], edgecolor="none", zorder=4)
    if shade is not None:
        rgba, ext, _ = shade
        ax.imshow(rgba, extent=ext, origin="upper", interpolation="bilinear", zorder=5)
    draw_polys(ax, D.sea, clip, facecolor=C["sea"], edgecolor="none", zorder=6)
    draw_polys(ax, D.water, clip, facecolor=C["water"], edgecolor=C["water_edge"],
               linewidth=lw(0.12 / k), zorder=6)
    draw_lines(ax, D.rivers, clip, C["water_edge"], 0.35 / k, 6.5)
    if not overview:
        draw_polys(ax, D.protected, clip, facecolor="none", edgecolor=C["protected"],
                   linewidth=lw(0.35), linestyle=(0, (4, 2)), alpha=0.75, zorder=7)
        draw_polys(ax, D.airport, clip, facecolor="#e3e0ea", edgecolor="#9d97b0",
                   linewidth=lw(0.15), zorder=7)

    # Radrouten als Band unter den Straßen
    cyc = D.cycle
    draw_lines(ax, cyc[cyc["net"] == "rcn"], clip, C["cycle_r"], 1.2 / (1.6 if overview else 1), 8,
               alpha=0.55)
    draw_lines(ax, cyc[cyc["net"].isin(["ncn", "icn"])], clip, C["cycle_n"],
               1.7 / (1.6 if overview else 1), 8.1, alpha=0.5)

    if not overview:
        draw_lines(ax, D.cycleway, clip, "#2f8f4f", 0.22, 9)
    # Straßen
    rd = D.roads
    levels = ROADS[1:] if overview else ROADS
    for i, (vals, case, fill, wc, wf) in enumerate(levels):
        draw_lines(ax, rd[rd["highway"].isin(vals)], clip, case, wc / k, 10 + i)
    for i, (vals, case, fill, wc, wf) in enumerate(levels):
        draw_lines(ax, rd[rd["highway"].isin(vals)], clip, fill, wf / k, 20 + i)
    # Bahn, Fähren
    draw_lines(ax, D.rail, clip, C["rail"], 0.62 / k, 30)
    if not overview:
        draw_lines(ax, D.rail, clip, "white", 0.32, 31, linestyles=(0, (4, 4)))
    draw_lines(ax, D.ferry, clip, C["ferry"], 0.4 / k, 30, linestyles=(0, (3, 2)))

    # Orte: Punkte
    pl = D.places.cx[clip[0]:clip[2], clip[1]:clip[3]]
    for kind, r_mm in (("city", 1.3), ("town", 0.95), ("village", 0.55), ("hamlet", 0.38)):
        if overview and kind in ("village", "hamlet"):
            continue
        s = pl[pl["place"] == kind]
        for g in s.geometry:
            ax.add_patch(Circle((g.x, g.y), r_mm * M_PER_MM * (1.8 if overview else 1),
                                facecolor="white" if kind in ("city", "town") else "#555",
                                edgecolor="#222", linewidth=lw(0.2), zorder=50))
    if L is not None:
        L.draw(ax, clip)
    if D.track is None:
        return
    # eigene Route (optional)
    tr = D.track
    ax.plot(tr[:, 0], tr[:, 1], color="white", lw=lw(2.0 / (1.4 if overview else 1)),
            solid_capstyle="round", solid_joinstyle="round", zorder=40)
    ax.plot(tr[:, 0], tr[:, 1], color=C["route"], lw=lw(1.1 / (1.4 if overview else 1)),
            solid_capstyle="round", solid_joinstyle="round", zorder=41)
    if not overview:
        # km-Marken alle 10 km, Zahl alle 50 km
        for km in range(10, int(D.cum[-1] / 1000), 10):
            j = int(np.searchsorted(D.cum, km * 1000))
            x, y = tr[j]
            ax.add_patch(Circle((x, y), 0.55 * M_PER_MM, facecolor="white", edgecolor=C["route"],
                                linewidth=lw(0.25), zorder=42))
            if km % 50 == 0:
                ax.text(x, y + 1.6 * M_PER_MM, f"km {km}", fontsize=5.5, ha="center", va="bottom",
                        color=C["route"], fontweight="bold", path_effects=halo(1.8), zorder=63)

    # Etappenmarker
    rr = (2.6 if not overview else 2.2) * M_PER_MM * (1 if not overview else 4)
    for s, dlab in zip(D.stops, days):
        ax.add_patch(Circle((s["x"], s["y"]), rr, facecolor="white", edgecolor=C["route"],
                            linewidth=lw(0.6), zorder=70))
        ax.text(s["x"], s["y"], dlab, fontsize=(6.6 if len(dlab) < 3 else 5.0) * (1 if not overview else 0.95),
                ha="center", va="center", fontweight="bold", color=C["route"], zorder=71)
    for (x, y), lab in ((tr[0], "S"), (tr[-1], "Z")):
        ax.add_patch(Circle((x, y), rr * 1.15, facecolor=C["route"], edgecolor="white",
                            linewidth=lw(0.5), zorder=70))
        ax.text(x, y, lab, fontsize=7.5, ha="center", va="center", fontweight="bold",
                color="white", zorder=71)


def col_letter(i):
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]


def draw_grid(ax, clip, labels=True):
    gx0 = X0
    for gx in np.arange(gx0, X1 + 1, GRID):
        ax.plot([gx, gx], [Y0, YTOP], color=C["grid"], lw=lw(0.16), alpha=0.6, zorder=80)
    for gy in np.arange(YTOP, Y0 - 1, -GRID):
        ax.plot([X0, X1], [gy, gy], color=C["grid"], lw=lw(0.16), alpha=0.6, zorder=80)
    if not labels:
        return
    st = dict(fontsize=7, fontweight="bold", color=C["grid"], ha="center", va="center", zorder=82,
              bbox=dict(boxstyle="round,pad=0.18", fc="white", ec=C["grid"], lw=0.4, alpha=0.9))
    pad = 2.6 * M_PER_MM
    for ci in range(int(XW // GRID)):
        cx = X0 + (ci + 0.5) * GRID
        if clip[0] < cx < clip[2]:
            ax.text(cx, clip[3] - pad, col_letter(ci), **st)
            ax.text(cx, clip[1] + pad, col_letter(ci), **st)
    for ri in range(int(YH // GRID)):
        cy = YTOP - (ri + 0.5) * GRID
        if clip[1] < cy < clip[3]:
            ax.text(clip[0] + pad, cy, str(ri + 1), **st)
            ax.text(clip[2] - pad, cy, str(ri + 1), **st)


def draw_graticule_ticks(fig, ax, clip):
    """Geogr. Koordinaten als Randmarken (alle 5')."""
    def fmt(v):
        d = int(v + 1e-9)
        m = round((v - d) * 60)
        return f"{d}°{m:02d}'"
    lon0, lat0, lon1, lat1 = TO_LL.transform_bounds(*clip)
    for edge_y, va, sgn in ((clip[3], "bottom", 1), (clip[1], "top", -1)):
        for lon in np.arange(math.floor(lon0 * 12) / 12, lon1 + 0.01, 1 / 12):
            # Schnitt der Meridianlinie mit der Blattkante (Newton)
            lat = 56.5
            for _ in range(4):
                x, y = TO_M.transform(lon, lat)
                _, lat = TO_LL.transform(x, edge_y)
            x, _ = TO_M.transform(lon, lat)
            if clip[0] + 1000 < x < clip[2] - 1000:
                ax.plot([x, x], [edge_y, edge_y + sgn * 1.8 * M_PER_MM], color="black",
                        lw=lw(0.25), clip_on=False, zorder=90)
                ax.text(x, edge_y + sgn * 2.2 * M_PER_MM, fmt(lon) + " O", fontsize=5,
                        ha="center", va=va, clip_on=False)
    for edge_x, ha, sgn in ((clip[0], "right", -1), (clip[2], "left", 1)):
        for lat in np.arange(math.floor(lat0 * 12) / 12, lat1 + 0.01, 1 / 12):
            lon = 12.5
            for _ in range(4):
                x, y = TO_M.transform(lon, lat)
                lon, _ = TO_LL.transform(edge_x, y)
            _, y = TO_M.transform(lon, lat)
            if clip[1] + 1000 < y < clip[3] - 1000:
                ax.plot([edge_x, edge_x + sgn * 1.8 * M_PER_MM], [y, y], color="black",
                        lw=lw(0.25), clip_on=False, zorder=90)
                ax.text(edge_x + sgn * 2.2 * M_PER_MM, y, fmt(lat) + " N", fontsize=5,
                        ha=ha, va="center", rotation=90, rotation_mode="anchor", clip_on=False)


def add_axes_mm(fig, x, y_top, w, h):
    """Achse in mm-Koordinaten vom linken oberen Blattrand."""
    return fig.add_axes([x / PAGE_W, 1 - (y_top + h) / PAGE_H, w / PAGE_W, h / PAGE_H])


# ---------------------------------------------------------------- Legende
def legend(fig, x, y, w, D, days, n_days, title=True, stages=True):
    ax = add_axes_mm(fig, x, y, w, 10)  # Platzhalter für Koordinaten
    ax.remove()
    items = []
    yy = y

    def T(txt, dy, fs=7, bold=False, color="#222", xo=0):
        nonlocal yy
        fig.text((x + xo) / PAGE_W, 1 - yy / PAGE_H, txt, fontsize=fs, fontweight="bold" if bold else "normal",
                 color=color, va="top", ha="left")
        yy += dy

    def sym(kind, *a):
        return kind, a

    if title:
        T("Südschweden", 8.5, 19, True, "#1f5f8f")
        T("Skåne · Halland · Västergötland · Göteborg", 5.5, 8.5)
        T(f"Maßstab 1:{SCALE:,}".replace(",", ".") + "  ·  1 cm = 2 km  ·  Gitter 10 km (SWEREF 99 TM)", 7, 7.5)
    # Symbole
    rows = []
    if D.track is not None:
        rows += [
            ("route", "Unsere Route (~%d km)" % round(D.cum[-1] / 1000)),
            ("stop", "Etappenende = Schlafplatz von Tag N (5/6 = mit Ruhetag)"),
            ("km", "km-Marke alle 10 km"),
        ]
    rows += [
        ("cycn", "Nationale Radroute (Sydkustleden, Kattegattleden …)"),
        ("cycr", "Regionale Radroute"),
        ("cycleway", "Radweg"),
        ("motorway", "Autobahn"), ("primary", "Hauptstraße"), ("secondary", "Landstraße"),
        ("tertiary", "Verbindungsstraße"), ("unclassified", "Nebenstraße"),
        ("rail", "Eisenbahn"), ("ferry", "Fähre"),
        ("forest", "Wald"), ("water", "See, Meer"), ("urban", "Ortschaft"),
        ("wetland", "Moor, Sumpf"), ("protected", "Naturreservat / Nationalpark"),
    ]
    sx = x
    for kind, text in rows:
        ax = add_axes_mm(fig, sx, yy - 1.6, 12, 3.6)
        ax.set_xlim(0, 12)
        ax.set_ylim(0, 3.6)
        ax.axis("off")
        m = 1 / 0.3528  # mm -> pt
        if kind == "route":
            ax.plot([0.5, 11.5], [1.8, 1.8], color="white", lw=2.0 * m)
            ax.plot([0.5, 11.5], [1.8, 1.8], color=C["route"], lw=1.1 * m)
        elif kind == "stop":
            ax.add_patch(Circle((6, 1.8), 1.6, fc="white", ec=C["route"], lw=0.6 * m))
            ax.text(6, 1.8, "7", fontsize=6.5, ha="center", va="center", color=C["route"], fontweight="bold")
            ax.set_aspect("equal")
        elif kind == "km":
            ax.plot([0.5, 11.5], [1.8, 1.8], color=C["route"], lw=1.1 * m)
            ax.add_patch(Circle((6, 1.8), 0.55, fc="white", ec=C["route"], lw=0.25 * m))
            ax.set_aspect("equal")
        elif kind in ("cycn", "cycr"):
            ax.plot([0.5, 11.5], [1.8, 1.8], color=C["cycle_n" if kind == "cycn" else "cycle_r"],
                    lw=(1.7 if kind == "cycn" else 1.2) * m, alpha=0.5 if kind == "cycn" else 0.55)
        elif kind == "cycleway":
            ax.plot([0.5, 11.5], [1.8, 1.8], color="#2f8f4f", lw=0.22 * m)
        elif kind in ("motorway", "primary", "secondary", "tertiary", "unclassified"):
            for vals, case, fill, wc, wf in ROADS:
                if kind in vals:
                    ax.plot([0.5, 11.5], [1.8, 1.8], color=case, lw=wc * m, solid_capstyle="butt")
                    ax.plot([0.5, 11.5], [1.8, 1.8], color=fill, lw=wf * m, solid_capstyle="butt")
        elif kind == "rail":
            ax.plot([0.5, 11.5], [1.8, 1.8], color=C["rail"], lw=0.62 * m, solid_capstyle="butt")
            ax.plot([0.5, 11.5], [1.8, 1.8], color="white", lw=0.32 * m, ls=(0, (4, 4)))
        elif kind == "ferry":
            ax.plot([0.5, 11.5], [1.8, 1.8], color=C["ferry"], lw=0.4 * m, ls=(0, (3, 2)))
        else:
            fc = {"forest": C["forest"], "water": C["water"], "urban": C["urban"],
                  "wetland": C["wetland"], "protected": "none"}[kind]
            ec = {"water": C["water_edge"], "protected": C["protected"], "wetland": "#8fb39a"}.get(kind, "none")
            ax.add_patch(Rectangle((1, 0.4), 10, 2.8, fc=fc, ec=ec, lw=0.35 * m,
                                   hatch="--" if kind == "wetland" else None,
                                   ls=(0, (4, 2)) if kind == "protected" else "-"))
        fig.text((sx + 14) / PAGE_W, 1 - (yy + 0.2) / PAGE_H, text, fontsize=6.6, va="center", ha="left")
        yy += 4.1
    yy += 1.5
    T("Feldangabe: Spalte + Zeile, z. B. „E14“ (Buchstaben oben/unten,", 3.2, 6.3)
    T("Zahlen links/rechts). Randzahlen: geogr. Breite/Länge alle 5'.", 5, 6.3)
    if stages and D.track is not None:
        T("Etappen", 4.6, 9, True, C["route"])
        prev = 0.0
        lines = []
        for s, dlab in zip(D.stops, days):
            lines.append((dlab, s["name"], s["km"] - prev, s["km"]))
            prev = s["km"]
        lines.append((str(n_days), "Göteborg, Fähre (Ziel)", D.cum[-1] / 1000 - prev, D.cum[-1] / 1000))
        for dlab, nm, d, tot in lines:
            fig.text((x + 0) / PAGE_W, 1 - yy / PAGE_H, f"Tag {dlab}", fontsize=6.3, fontweight="bold",
                     color=C["route"], va="top")
            fig.text((x + 13) / PAGE_W, 1 - yy / PAGE_H, nm, fontsize=6.3, va="top")
            fig.text((x + w - 13) / PAGE_W, 1 - yy / PAGE_H, f"{d:4.0f} km", fontsize=6.3, va="top", ha="right")
            fig.text((x + w) / PAGE_W, 1 - yy / PAGE_H, f"Σ {tot:.0f}", fontsize=6.0, va="top", ha="right",
                     color="#666")
            yy += 3.3
        yy += 1
    return yy


ATTRIB = ("Kartendaten © OpenStreetMap-Mitwirkende (ODbL, openstreetmap.org/copyright) · "
          "Meer: osmdata.openstreetmap.de · Höhen: Copernicus DEM GLO-30 © DLR e.V. 2010-2014 und "
          "© Airbus Defence and Space GmbH 2014-2018, bereitgestellt durch EU/ESA")


def sheet_clip(c, r):
    x0 = X0 + c * SHEET_W * M_PER_MM
    y1 = YTOP - r * SHEET_H * M_PER_MM
    return (x0, y1 - SHEET_H * M_PER_MM, x0 + SHEET_W * M_PER_MM, y1)


def render_sheet(D, L, shade, days, n_days, c, r, out_png, legend_at=None):
    fig = plt.figure(figsize=(PAGE_W / 25.4, PAGE_H / 25.4), dpi=DPI)
    fig.patch.set_facecolor("white")
    ax = add_axes_mm(fig, OFF_L, OFF_T, SHEET_W, SHEET_H)
    clip = sheet_clip(c, r)
    ax.set_xlim(clip[0], clip[2])
    ax.set_ylim(clip[1], clip[3])
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    draw_map(ax, D, clip, L, shade, days)
    draw_grid(ax, clip)
    for s in ax.spines.values():
        s.set_linewidth(lw(0.35))
        s.set_zorder(95)
    draw_graticule_ticks(fig, ax, clip)

    n = r * COLS + c + 1
    if legend_at:
        lx, ly, lwid, lh = legend_at
        bx = add_axes_mm(fig, lx - 3, ly - 3, lwid + 6, lh + 6)
        bx.set_xlim(0, 1)
        bx.set_ylim(0, 1)
        bx.axis("off")
        bx.add_patch(FancyBboxPatch((0, 0), 1, 1, boxstyle="round,pad=0,rounding_size=0.01",
                                    fc="white", ec="#666", lw=0.5, alpha=0.93,
                                    transform=bx.transAxes))
        legend(fig, lx, ly, lwid, D, days, n_days)

    # Blattrand: Info + Mini-Blattübersicht
    fig.text(OFF_L / PAGE_W, 1 - (OFF_T + SHEET_H + 8.6) / PAGE_H,
             f"Blatt {n} von {COLS * ROWS}  ·  Südschweden 1:{SCALE:,}".replace(",", ".") +
             "  ·  Zum Zusammenkleben den weißen Rand oben bzw. links an der Kartenkante abschneiden "
             "und auf das Nachbarblatt legen.", fontsize=5.6, va="center")
    fig.text(OFF_L / PAGE_W, 1 - (OFF_T + SHEET_H + 11.2) / PAGE_H, ATTRIB, fontsize=4.3, va="center",
             color="#555")
    mx = OFF_L + SHEET_W - 2 * 2.6
    for rr in range(ROWS):
        for cc in range(COLS):
            fig.patches.append(Rectangle(((mx + cc * 2.6) / PAGE_W, 1 - (OFF_T + SHEET_H + 3.5 + (rr + 1) * 1.75) / PAGE_H),
                                         2.4 / PAGE_W, 1.55 / PAGE_H, transform=fig.transFigure,
                                         fc=C["route"] if (rr, cc) == (r, c) else "#ddd", ec="none"))
    fig.savefig(out_png, dpi=DPI, facecolor="white")
    plt.close(fig)


def render_overview(D, shade, days, n_days, out_png):
    """A3-Übersicht 1:800 000 mit Blatteinteilung, Legende und Etappenliste."""
    fig = plt.figure(figsize=(PAGE_W / 25.4, PAGE_H / 25.4), dpi=DPI)
    k = 4
    mw, mh = SHEET_W * COLS / k, SHEET_H * ROWS / k   # 137.5 x 400 mm
    ax = add_axes_mm(fig, 10, 10, mw, mh)
    clip = (X0, Y0, X1, YTOP)
    ax.set_xlim(X0, X1)
    ax.set_ylim(Y0, YTOP)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    L = Labeler()
    for s in D.stops:
        r = 2.4 * M_PER_MM * k
        L.block((s["x"] - r, s["y"] - r, s["x"] + r, s["y"] + r))
    pl = D.places
    for kind, fs in (("city", 9), ("town", 6.2)):
        for _, rw in pl[pl["place"] == kind].sort_values("pop", ascending=False).iterrows():
            if isinstance(rw["name"], str):
                g = rw.geometry
                Ls = Labeler.size(rw["name"], fs, kind == "city")
                w, h = Ls[0] * k, Ls[1] * k
                for ha, ox in (("left", 1), ("right", -1)):
                    x0 = g.x + ox * 1.5 * M_PER_MM * k - (w if ha == "right" else 0)
                    bx = (x0, g.y - h / 2, x0 + w, g.y + h / 2)
                    if L.free(bx):
                        L.block(bx)
                        L.items.append(dict(x=g.x + ox * 1.5 * M_PER_MM * k, y=g.y, text=rw["name"], fs=fs,
                                            ha=ha, va="center", weight="bold" if kind == "city" else "normal",
                                            z=62, halo=1.6))
                        break
    draw_map(ax, D, clip, L, shade, days, overview=True)
    # Blatteinteilung
    for r in range(ROWS):
        for c in range(COLS):
            x0, y0, x1, y1 = sheet_clip(c, r)
            ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, fill=False, ec="#1f5f8f", lw=lw(0.5),
                                   zorder=85))
            ax.text(x0 + 1500 * k, y1 - 1500 * k, f"Blatt {r * COLS + c + 1}", fontsize=8, fontweight="bold",
                    color="#1f5f8f", ha="left", va="top", zorder=86, path_effects=halo(2))
    for s in ax.spines.values():
        s.set_linewidth(lw(0.35))
    yy = legend(fig, 157, 12, 130, D, days, n_days)
    fig.text(157 / PAGE_W, 1 - (yy + 2) / PAGE_H,
             "Übersicht 1:800.000 (1 cm = 8 km). Die 8 Detailblätter 1:200.000 ergeben\n"
             "zusammengeklebt ein Poster von ca. 55 × 156 cm (2 Spalten × 4 Reihen).",
             fontsize=6.6, va="top")
    fig.text(10 / PAGE_W, 1 - 414 / PAGE_H, ATTRIB, fontsize=4.3, va="center", color="#555")
    fig.savefig(out_png, dpi=DPI)
    plt.close(fig)


def main():
    global DPI
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--gpx", default="", help="optional: Route + Schlafplätze einzeichnen")
    ap.add_argument("--out", required=True, help="PDF-Datei (alle Blätter)")
    ap.add_argument("--sheets", default="", help="z. B. 3,4 (leer = alle); 0 = Übersicht")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--legend", default="0,1,8,222,112,100",
                    help="Spalte,Reihe,x_mm,y_mm,Breite,Höhe der Legende auf einem Blatt")
    a = ap.parse_args()
    DPI = a.dpi
    D = Data(a.data, a.gpx)
    days, n_days = stage_days(D.stops)
    print("Schummerung …", flush=True)
    shade = hillshade(D.dem_path)
    print("Beschriftung …", flush=True)
    L = build_labels(D, days)
    lc, lr, lx, ly, lwid, lh = [float(v) for v in a.legend.split(",")]
    want = {int(s) for s in a.sheets.split(",") if s.strip()} or set(range(0, COLS * ROWS + 1))
    outdir = os.path.dirname(os.path.abspath(a.out))
    pngs = []
    if 0 in want:
        p = os.path.join(outdir, "blatt-0-uebersicht.png")
        print("Übersicht …", flush=True)
        render_overview(D, shade, days, n_days, p)
        pngs.append(p)
    for r in range(ROWS):
        for c in range(COLS):
            n = r * COLS + c + 1
            if n not in want:
                continue
            p = os.path.join(outdir, f"blatt-{n}.png")
            print(f"Blatt {n} …", flush=True)
            leg = (OFF_L + lx, OFF_T + ly, lwid, lh) if (c, r) == (int(lc), int(lr)) else None
            render_sheet(D, L, shade, days, n_days, c, r, p, legend_at=leg)
            pngs.append(p)
    import img2pdf
    from PIL import Image
    jpgs = []
    for p in pngs:   # JPEG q90 hält das PDF bei ~50 MB statt >100 MB
        j = p[:-4] + ".jpg"
        Image.open(p).convert("RGB").save(j, quality=90, dpi=(DPI, DPI), subsampling=0)
        jpgs.append(j)
    pngs = jpgs
    layout = img2pdf.get_layout_fun((img2pdf.mm_to_pt(PAGE_W), img2pdf.mm_to_pt(PAGE_H)))
    with open(a.out, "wb") as f:
        f.write(img2pdf.convert(pngs, layout_fun=layout))
    print("fertig:", a.out)


if __name__ == "__main__":
    sys.exit(main())
