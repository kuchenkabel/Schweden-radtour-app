#!/usr/bin/env python3
"""Lädt die amtlichen Schutzgebiete Schwedens (Naturvårdsverket, Naturvårdsregistret, CC0).

Nationalparks, Naturreservate, Naturvårdsområden usw. aus dem WFS-Layer
Naturvardsregistret_WFS:SkyddadeOmraden, dazu Natura 2000 (N2000_WFS:N2000).
OSM kennt längst nicht alle Reservate; für "Punkt prüfen" muss ein Schutzgebiet
zuverlässig erkannt werden, deshalb kommt die amtliche Quelle dazu.

Ausgabe: GeoJSON-Sequenz (eine Zeile je Fläche) mit den Eigenschaften
  boundary=protected_area, name, protection_title (Schutzart), source=Naturvårdsverket
in WGS84, so dass build_camp.py sie wie OSM-Schutzgebiete liest.
Bricht mit Fehler ab, wenn keine Nationalparks/Reservate geladen werden konnten.

Aufruf: fetch_protected.py <ausgabe.geojsonseq>
"""
import json
import re
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "schweden-radtour-app-datapipeline/1.0 (github.com/kuchenkabel/schweden-radtour-app)"}
SOURCES = [
    ("https://geodata.naturvardsverket.se/naturvardsregistret/wfs", "SkyddadeOmraden", True),
    ("https://geodata.naturvardsverket.se/n2000/wfs", "N2000", False),
]
PAGE = 2000


def get(url, timeout=300):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def capabilities(base, want):
    caps = get(f"{base}?service=WFS&request=GetCapabilities&version=2.0.0", 60).decode("utf-8", "replace")
    names = re.findall(r"<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>", caps)
    layer = next((n for n in names if n.split(":")[-1] == want), None) or next((n for n in names if want.lower() in n.lower()), None)
    if not layer:
        raise RuntimeError(f"Ebene {want} nicht gefunden: {names}")
    gf = caps[caps.find('name="GetFeature"'):]
    blk = gf[gf.find('name="outputFormat"'):]
    blk = blk[:blk.find("</ows:Parameter>")]
    fmts = [f for f in re.findall(r"<ows:Value>([^<]+)</ows:Value>", blk) if "json" in f.lower()]
    return layer, fmts + ["application/json", "json"]


def first(props, *keys):
    low = {k.lower(): v for k, v in props.items()}
    for k in keys:
        v = low.get(k.lower())
        if v not in (None, ""):
            return str(v)
    return ""


def fetch(base, want):
    layer, fmts = capabilities(base, want)
    print(f"{base}: Ebene {layer}", file=sys.stderr)
    fmt = None
    out, start = [], 0
    while True:
        fc = None
        for f in ([fmt] if fmt else list(dict.fromkeys(fmts))):
            q = urllib.parse.urlencode({
                "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer,
                "outputFormat": f, "srsName": "EPSG:4326", "count": PAGE, "startIndex": start,
            })
            body = get(f"{base}?{q}")
            try:
                fc = json.loads(body)
                fmt = f
                break
            except ValueError:
                print(f"  Format {f}: {body[:150]!r}", file=sys.stderr)
        if fc is None:
            raise RuntimeError("keine GeoJSON-Antwort")
        feats = fc.get("features") or []
        out.extend(feats)
        total = fc.get("numberMatched") or fc.get("totalFeatures")
        print(f"  {len(out)} von {total or '?'} Flächen", file=sys.stderr)
        # Server begrenzen die Seitengröße teils selbst (z.B. 500): weiter, bis eine Seite leer ist
        if not feats or (isinstance(total, int) and len(out) >= total):
            return out
        start += len(feats)


def swap_if_needed(geom):
    """Manche WFS liefern in EPSG:4326 Breite/Länge statt Länge/Breite."""
    def first_xy(c):
        while isinstance(c[0], list):
            c = c[0]
        return c
    def swap(c):
        return [swap(x) for x in c] if isinstance(c[0], list) else [c[1], c[0]] + c[2:]
    x, y = first_xy(geom["coordinates"])[:2]
    if 54 < x < 70 and 10 < y < 25:
        geom = {"type": geom["type"], "coordinates": swap(geom["coordinates"])}
    return geom


def main(dst):
    n = {}
    with open(dst, "w", encoding="utf-8") as f:
        for base, want, required in SOURCES:
            try:
                feats = fetch(base, want)
            except Exception as e:  # noqa: BLE001
                if required:
                    raise
                print(f"WARNUNG {want}: {e}", file=sys.stderr)
                continue
            for ft in feats:
                g = ft.get("geometry")
                if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
                    continue
                p = ft.get("properties") or {}
                title = first(p, "SKYDDSTYP", "skyddstyp", "SKYDDSTYP_TEXT") or ("Natura 2000" if want == "N2000" else "Schutzgebiet")
                if "vattenskydd" in title.lower():  # Trinkwasserschutz, keine Naturschutz-Regeln fürs Zelten
                    continue
                props = {"boundary": "protected_area", "protection_title": title,
                         "name": first(p, "NAMN", "namn", "name", "OMRADESNAMN")[:80], "source": "Naturvårdsverket"}
                f.write(json.dumps({"type": "Feature", "properties": props, "geometry": swap_if_needed(g)},
                                   ensure_ascii=False, separators=(",", ":")) + "\n")
                n[title] = n.get(title, 0) + 1
    print("Schutzgebiete:", json.dumps(n, ensure_ascii=False), file=sys.stderr)
    main_types = sum(v for k, v in n.items() if "reservat" in k.lower() or "nationalpark" in k.lower())
    if main_types < 1000:
        sys.exit(f"zu wenige Nationalparks/Naturreservate ({main_types}) – Abbruch, damit keine Karte ohne Schutzgebiete entsteht")


if __name__ == "__main__":
    main(sys.argv[1])
