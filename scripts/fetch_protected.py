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
CAP = 2000  # beobachtete Höchstzahl je Abfrage beim Naturvårdsregistret-WFS


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


def fetch_paged(base, layer, fmts, extra=None, fmt=None):
    """Alle Seiten einer Abfrage; gibt (Flächen, benutztes Format) zurück."""
    out, start = [], 0
    while True:
        fc = None
        for f in ([fmt] if fmt else list(dict.fromkeys(fmts))):
            q = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer,
                 "outputFormat": f, "srsName": "EPSG:4326", "count": PAGE, "startIndex": start}
            q.update(extra or {})
            body = get(f"{base}?{urllib.parse.urlencode(q)}")
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
        # Server begrenzen die Seitengröße teils selbst (z.B. 500): weiter, bis eine Seite leer ist
        if not feats or (isinstance(total, int) and len(out) >= total):
            return out, fmt
        start += len(feats)


def lonlat(ft):
    g = ft.get("geometry")
    if not g or not g.get("coordinates"):
        return None
    c = swap_if_needed(g)["coordinates"]
    while isinstance(c[0], list):
        c = c[0]
    return c[0], c[1]


def inside(feats, w, s, e, n, tol=0.5):
    pts = [p for p in map(lonlat, feats) if p]
    ok = sum(1 for x, y in pts if w - tol <= x <= e + tol and s - tol <= y <= n + tol)
    return pts and ok >= 0.8 * len(pts)


def bbox_param(order, w, s, e, n):
    if order == "latlon":
        return {"bbox": f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326"}
    return {"bbox": f"{w},{s},{e},{n},urn:ogc:def:crs:OGC:1.3:CRS84"}


def fetch(base, want):
    layer, fmts = capabilities(base, want)
    print(f"{base}: Ebene {layer}", file=sys.stderr)
    feats, fmt = fetch_paged(base, layer, fmts)
    print(f"  ohne Ausschnitt: {len(feats)} Flächen", file=sys.stderr)
    if len(feats) < CAP:
        return feats
    # Manche Server liefern höchstens CAP Flächen je Abfrage, auch beim Weiterblättern.
    # Dann in Kacheln abfragen und Kacheln mit zu vielen Treffern weiter teilen.
    order = None
    for o in ("latlon", "lonlat"):
        probe, _ = fetch_paged(base, layer, fmts, bbox_param(o, 17.5, 59.0, 19.0, 59.8), fmt)
        print(f"  Achsenfolge {o}: {len(probe)} Flächen im Raum Stockholm", file=sys.stderr)
        if inside(probe, 17.5, 59.0, 19.0, 59.8) and len(probe) < len(feats):
            order = o
            break
    if not order:
        raise RuntimeError("Abfrage mit Ausschnitt funktioniert nicht, mehr als %d Flächen nicht ladbar" % CAP)
    seen = {}
    todo = [(w, s, w + 3.5, s + 3.75, 0) for w in (10.5, 14.0, 17.5, 21.0) for s in (55.0, 58.75, 62.5, 66.25)]
    while todo:
        w, s, e, n, depth = todo.pop()
        part, _ = fetch_paged(base, layer, fmts, bbox_param(order, w, s, e, n), fmt)
        if len(part) >= CAP * 0.9:
            if depth >= 8:
                raise RuntimeError(f"Kachel {w},{s},{e},{n} hat zu viele Flächen")
            mx, my = (w + e) / 2, (s + n) / 2
            todo += [(w, s, mx, my, depth + 1), (mx, s, e, my, depth + 1),
                     (w, my, mx, n, depth + 1), (mx, my, e, n, depth + 1)]
            continue
        for ft in part:
            key = ft.get("id") or json.dumps(ft.get("properties"), sort_keys=True)
            seen[key] = ft
        print(f"  Kachel {w:.2f},{s:.2f}: {len(part)}, zusammen {len(seen)} Flächen", file=sys.stderr)
    return list(seen.values())


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
    # Schweden hat über 5000 Naturreservate; deutlich weniger heißt: Laden unvollständig
    if main_types < 4000:
        sys.exit(f"zu wenige Nationalparks/Naturreservate ({main_types}) – Abbruch, damit keine Karte ohne Schutzgebiete entsteht")


if __name__ == "__main__":
    main(sys.argv[1])
