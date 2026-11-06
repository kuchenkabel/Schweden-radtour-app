#!/usr/bin/env python3
"""Lädt unabhängige Vergleichsdaten für Vindskydd (ohne Anmeldung, offene Lizenzen).

Quellen:
  * Naturvårdsverket "Leder och friluftsanordningar" (CC0): Anordnungen in Naturreservaten
    und Nationalparks, u.a. Typ "Vindskydd". WFS, Ausgabe GeoJSON in WGS84.
  * Offene Geodaten von Kommunen auf ArcGIS Hub (Suche nach "vindskydd").

Ausgabe: refs.json = [{"lat":..,"lon":..,"src":"nv"|"kom","name":..,"org":..}, ...]
Fehler einzelner Quellen brechen nicht ab (Datenpaket soll trotzdem entstehen).

Aufruf: fetch_refs.py <ausgabe.json>
"""
import json
import re
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "schweden-radtour-app-datapipeline/1.0 (github.com/kuchenkabel/schweden-radtour-app)"}
NV_WFS = "https://geodata.naturvardsverket.se/anordningar_friluftsliv/wfs"
HUB = "https://hub.arcgis.com/api/v3/datasets"
SWEDEN = (10.5, 55.0, 24.5, 69.5)


def get(url, timeout=45):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def in_sweden(lon, lat):
    if not (SWEDEN[0] <= lon <= SWEDEN[2] and SWEDEN[1] <= lat <= SWEDEN[3]):
        return False
    if lat < 65.5 and lon > 21.6:  # finnische Westküste
        return False
    if 59.7 <= lat <= 60.6 and lon > 19.3:  # Åland
        return False
    return True


def point_of(geom):
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return c[0], c[1]
    if t == "MultiPoint" and c:
        return c[0][0], c[0][1]
    return None


def is_vindskydd(props):
    return any(isinstance(v, str) and "vindskydd" in v.lower() for v in props.values())


def name_of(props):
    for k in ("NAMN", "Namn", "namn", "NAME", "name", "BENAMNING", "Benamning"):
        if props.get(k):
            return str(props[k])[:80]
    return ""


def fetch_nv():
    caps = get(f"{NV_WFS}?service=WFS&request=GetCapabilities&version=2.0.0").decode("utf-8", "replace")
    names = re.findall(r"<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>", caps)
    layer = next((n for n in names if "ANORDNING" in n.upper()), None)
    if not layer:
        raise RuntimeError(f"keine Anordnungs-Ebene gefunden: {names}")
    print(f"NV-Ebene: {layer}", file=sys.stderr)
    fc, errors = None, []
    for fmt in ("application/json", "json"):
        q = urllib.parse.urlencode({
            "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer,
            "outputFormat": fmt, "srsName": "EPSG:4326",
        })
        body = get(f"{NV_WFS}?{q}", timeout=300)
        try:
            fc = json.loads(body)
            break
        except ValueError:
            errors.append(body[:300].decode("utf-8", "replace"))
    if fc is None:
        raise RuntimeError("WFS-Antwort ist kein GeoJSON: " + " | ".join(errors))
    out = []
    for f in fc.get("features") or []:
        p = f.get("properties") or {}
        pt = point_of(f.get("geometry"))
        if not pt or not is_vindskydd(p):
            continue
        lon, lat = pt
        if not in_sweden(lon, lat):  # Achsen vertauscht?
            lon, lat = lat, lon
        if in_sweden(lon, lat):
            out.append({"lat": lat, "lon": lon, "src": "nv", "name": name_of(p), "org": "Naturvårdsverket"})
    print(f"  NV: {len(fc.get('features') or [])} Anordnungen insgesamt", file=sys.stderr)
    return out


def fetch_hub():
    out, seen = [], set()
    q = urllib.parse.urlencode({"q": "vindskydd", "page[size]": 100})
    res = json.loads(get(f"{HUB}?{q}"))
    for d in res.get("data", []):
        a = d.get("attributes", {})
        url = a.get("url") or ""
        if "FeatureServer" not in url and "MapServer" not in url:
            continue
        if "vindskydd" not in (a.get("name") or "").lower() or url in seen:
            continue
        seen.add(url)
        org = a.get("organization") or ""
        owner = (a.get("owner") or "").lower()
        # nur Daten von Behörden (ArcGIS-Organisation oder Kommun-Konto), keine Privatkonten
        if not org and not any(w in owner for w in ("kommun", "gis", ".se", "lansstyrelse", "region")):
            continue
        org = org or a.get("owner")
        try:
            qs = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson"})
            fc = json.loads(get(f"{url.rstrip('/')}/query?{qs}"))
        except Exception as e:  # noqa: BLE001
            print(f"  Kommune {org}: {e}", file=sys.stderr)
            continue
        n = 0
        for f in fc.get("features") or []:
            pt = point_of(f.get("geometry"))
            if pt and in_sweden(*pt):
                out.append({"lat": pt[1], "lon": pt[0], "src": "kom", "name": name_of(f.get("properties") or {}), "org": org})
                n += 1
        print(f"  Kommune {org}: {n}", file=sys.stderr)
    return out


def main(dst):
    refs = []
    for label, fn in (("Naturvårdsverket", fetch_nv), ("Kommunen (ArcGIS Hub)", fetch_hub)):
        try:
            got = fn()
            print(f"{label}: {len(got)} Vindskydd", file=sys.stderr)
            refs += got
        except Exception as e:  # noqa: BLE001
            print(f"WARNUNG {label} nicht geladen: {e}", file=sys.stderr)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(refs, f, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1])
