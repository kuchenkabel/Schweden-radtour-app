#!/usr/bin/env python3
"""Erzeugt das App-Icon (Adaptive Icon + PNG-Fallbacks).

Motiv: gelber Schweden-Umriss auf schwedischem Blau, davor ein weißes Fahrrad.
Der Umriss stammt aus scripts/icon/sweden.json (Natural-Earth-Daten, gemeinfrei,
Maßstab 1:50m, nur Festland, Gotland, Öland).

Aufruf: python3 scripts/make_icon.py [--preview DATEI.png]
Benötigt nur Pillow.
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
SWEDEN = os.path.join(ROOT, "scripts", "icon", "sweden.json")

BLUE = "#006AA7"   # Flaggenblau
YELLOW = "#FECC02"  # Flaggengelb
WHITE = "#FFFFFF"
HALO = BLUE        # Kontur in Hintergrundfarbe: Fahrrad wirkt "ausgestanzt"

# --- Schweden-Umriss im 108er-Raster -------------------------------------
SW_TOP, SW_BOTTOM = 20.0, 88.0   # y-Bereich der Silhouette
SW_CX = 50.0                      # horizontale Mitte


def sweden_polys():
    data = json.load(open(SWEDEN))
    polys = [p[0] for p in data["features"][0]["geometry"]["coordinates"]]
    lat_min = min(c[1] for p in polys for c in p)
    lat_max = max(c[1] for p in polys for c in p)
    k = math.cos(math.radians(62))
    lon_min = min(c[0] for p in polys for c in p)
    lon_max = max(c[0] for p in polys for c in p)
    s = (SW_BOTTOM - SW_TOP) / (lat_max - lat_min)
    width = (lon_max - lon_min) * k * s
    x0 = SW_CX - width / 2
    out = []
    for p in polys:
        if len(p) < 6:  # Mini-Inseln weglassen
            continue
        out.append([(round(x0 + (lon - lon_min) * k * s, 2),
                     round(SW_TOP + (lat_max - lat) * s, 2)) for lon, lat in p])
    return out


# --- Fahrrad (Linienzüge) ------------------------------------------------
# In Einheiten relativ zur Hinterradnabe, dann verschoben/skaliert.
_BIKE = {
    "RH": (0, 0), "FH": (26, 0), "BB": (11, 0), "ST": (7, -13),
    "HT": (22, -12), "HB": (21, -16),
    "L1": (19, -17), "L2": (24.5, -17), "S1": (4, -15), "S2": (10.5, -15),
    "SP": (7.6, -15),
}
BIKE_OFF = (46.0, 70.0)
BIKE_SC = 0.78
_P = {k: (round(BIKE_OFF[0] + x * BIKE_SC, 2), round(BIKE_OFF[1] + y * BIKE_SC, 2))
      for k, (x, y) in _BIKE.items()}
WR = round(9.0 * BIKE_SC, 2)  # Radius Laufrad
RH, FH, BB, ST, HT, HB = (_P[k] for k in ("RH", "FH", "BB", "ST", "HT", "HB"))
FRAME = [
    [RH, BB, ST, RH],          # Hinterbau
    [ST, HT],                  # Oberrohr
    [BB, HT],                  # Unterrohr
    [FH, HB],                  # Gabel + Vorbau
    [_P["L1"], _P["L2"]],      # Lenker
    [_P["S1"], _P["S2"]],      # Sattel
    [ST, _P["SP"]],            # Sattelstütze
]
STROKE = 2.6
HALO_W = 1.4            # zusätzliche Breite der Kontur je Seite


def vector_path_circle(c, r):
    x, y = c
    return (f"M{x - r},{y}a{r},{r} 0,1 0,{2 * r},0"
            f"a{r},{r} 0,1 0,{-2 * r},0z")


def bike_paths():
    paths = [vector_path_circle(RH, WR), vector_path_circle(FH, WR)]
    for line in FRAME:
        paths.append("M" + "L".join(f"{x},{y}" for x, y in line))
    return paths


def write_vectors():
    fg = ['<?xml version="1.0" encoding="utf-8"?>',
          '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
          '    android:width="108dp"', '    android:height="108dp"',
          '    android:viewportWidth="108"', '    android:viewportHeight="108">']
    for poly in sweden_polys():
        d = "M" + "L".join(f"{x},{y}" for x, y in poly) + "Z"
        fg.append(f'    <path android:fillColor="{YELLOW}" android:pathData="{d}"/>')
    for color, w in ((HALO, STROKE + 2 * HALO_W), (WHITE, STROKE)):
        for d in bike_paths():
            fg.append(f'    <path android:strokeColor="{color}" android:strokeWidth="{w}"'
                      f' android:strokeLineCap="round" android:strokeLineJoin="round"'
                      f' android:pathData="{d}"/>')
    fg.append('</vector>')
    with open(os.path.join(RES, "drawable", "ic_launcher_foreground.xml"), "w") as f:
        f.write("\n".join(fg) + "\n")

    bg = ['<?xml version="1.0" encoding="utf-8"?>',
          '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
          '    android:width="108dp"', '    android:height="108dp"',
          '    android:viewportWidth="108"', '    android:viewportHeight="108">',
          f'    <path android:fillColor="{BLUE}" android:pathData="M0,0h108v108h-108z"/>',
          '</vector>']
    with open(os.path.join(RES, "drawable", "ic_launcher_background.xml"), "w") as f:
        f.write("\n".join(bg) + "\n")


# --- Rasterisierung mit Pillow (für PNG-Fallbacks und Vorschau) ----------
def render(size, background=True):
    ss = 4
    S = size * ss
    sc = S / 108.0
    img = Image.new("RGBA", (S, S), BLUE if background else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for poly in sweden_polys():
        d.polygon([(x * sc, y * sc) for x, y in poly], fill=YELLOW)
    for color, w in ((HALO, STROKE + 2 * HALO_W), (WHITE, STROKE)):
        lw = w * sc
        for c in (RH, FH):
            r = WR * sc
            d.ellipse([c[0] * sc - r - lw / 2, c[1] * sc - r - lw / 2,
                       c[0] * sc + r + lw / 2, c[1] * sc + r + lw / 2],
                      outline=color, width=max(1, round(lw)))
        for line in FRAME:
            pts = [(x * sc, y * sc) for x, y in line]
            d.line(pts, fill=color, width=max(1, round(lw)))
            for x, y in pts:
                d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=color)
    return img.resize((size, size), Image.LANCZOS)


def mask(img, shape):
    S = img.size[0]
    m = Image.new("L", (S * 4, S * 4), 0)
    md = ImageDraw.Draw(m)
    if shape == "circle":
        md.ellipse([0, 0, S * 4 - 1, S * 4 - 1], fill=255)
    else:
        md.rounded_rectangle([0, 0, S * 4 - 1, S * 4 - 1], radius=S * 4 * 0.18, fill=255)
    m = m.resize((S, S), Image.LANCZOS)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), m)
    return out


DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def write_pngs():
    for name, f in DENSITIES.items():
        folder = os.path.join(RES, f"mipmap-{name}")
        # Legacy-Icons (vor Android 8): 48dp, sichtbarer Bereich = mittlere 72/108
        full = render(round(108 * f))
        crop = round(18 * f)
        full = full.crop((crop, crop, full.size[0] - crop, full.size[1] - crop))
        full = full.resize((round(48 * f), round(48 * f)), Image.LANCZOS)
        mask(full, "square").save(os.path.join(folder, "ic_launcher.png"))
        mask(full, "circle").save(os.path.join(folder, "ic_launcher_round.png"))


def preview(path):
    full = render(432)
    tiles = []
    for shape in ("circle", "square"):
        c = full.crop((72, 72, 360, 360))
        tiles.append(mask(c, shape))
    small = mask(render(192).crop((32, 32, 160, 160)).resize((96, 96), Image.LANCZOS), "circle")
    sheet = Image.new("RGBA", (432 + 288 * 2 + 96 + 80, 432), "#DDDDDD")
    sheet.paste(full, (0, 0))
    ImageDraw.Draw(sheet).ellipse([216 - 132, 216 - 132, 216 + 132, 216 + 132], outline="red")
    x = 452
    for t in tiles:
        sheet.paste(t, (x, 72), t)
        x += 300
    sheet.paste(small, (x, 168), small)
    sheet.save(path)


if __name__ == "__main__":
    if "--preview" in sys.argv:
        preview(sys.argv[sys.argv.index("--preview") + 1])
    else:
        write_vectors()
        write_pngs()
