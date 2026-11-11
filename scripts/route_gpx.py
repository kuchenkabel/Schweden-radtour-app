"""Berechnet eine Route aus routes/<name>.json mit BRouter (Abschnitt für Abschnitt)
und schreibt <name>.gpx und <name>.summary.json nach out/routes/.
Nur Standardbibliothek; läuft in GitHub Actions (BRouter ist aus der Sandbox nicht erreichbar)."""
import json, sys, time, math, urllib.request, pathlib

def brouter(a, b, profile):
    url = ("https://brouter.de/brouter?lonlats=%f,%f|%f,%f&profile=%s&alternativeidx=0&format=geojson"
           % (a[1], a[0], b[1], b[0], profile))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "radtour-planung"}), timeout=60) as r:
                return json.load(r)["features"][0]
        except Exception as e:
            print("Fehler", e, "neuer Versuch", file=sys.stderr); time.sleep(5 * (attempt + 1))
    raise SystemExit("BRouter nicht erreichbar")

def main(path):
    spec = json.load(open(path)); name = pathlib.Path(path).stem
    out = pathlib.Path("out/routes"); out.mkdir(parents=True, exist_ok=True)
    wps = spec["waypoints"]; coords = []; legs = []
    for a, b in zip(wps, wps[1:]):
        f = brouter(a[1:], b[1:], spec.get("profile", "trekking"))
        c = f["geometry"]["coordinates"]; p = f["properties"]
        coords += c if not coords else c[1:]
        legs.append({"from": a[0], "to": b[0], "km": round(int(p["track-length"]) / 1000, 1),
                     "ascend_m": int(p.get("filtered ascend", 0))})
        print(legs[-1]); time.sleep(1)
    gpx = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="radtour-planung" xmlns="http://www.topografix.com/GPX/1/1">',
           '<trk><name>%s</name><trkseg>' % spec["name"]]
    for c in coords:
        ele = '<ele>%.0f</ele>' % c[2] if len(c) > 2 else ''
        gpx.append('<trkpt lat="%.6f" lon="%.6f">%s</trkpt>' % (c[1], c[0], ele))
    gpx += ['</trkseg></trk>', '</gpx>']
    (out / f"{name}.gpx").write_text("\n".join(gpx))
    summ = {"name": spec["name"], "km": round(sum(l["km"] for l in legs), 1),
            "ascend_m": sum(l["ascend_m"] for l in legs), "legs": legs, "points": len(coords)}
    (out / f"{name}.summary.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1))
    print(json.dumps(summ, ensure_ascii=False))

if __name__ == "__main__":
    for p in sys.argv[1:]: main(p)
