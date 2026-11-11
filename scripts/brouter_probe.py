"""Prüft, wie sich BRouter-Profilparameter auf die Route auswirken (Familienprofil-Test).
Schreibt out/routes/brouter-probe.json."""
import json, urllib.request, urllib.parse, pathlib, time

TESTS = {
  "Halmstad-Torup": [(12.857, 56.674), (13.081, 56.957)],
  "Kinna-Mölnlycke": [(12.695, 57.509), (12.117, 57.659)],
  "Ängelholm-Båstad": [(12.862, 56.243), (12.853, 56.427)],
}
VARIANTS = {
  "trekking": None,
  "familie": {"UPHILLCOST": "80", "UPHILLCUTOFF": "3", "OFFROUTE": "0.3"},
  "familie_flach": {"UPHILLCOST": "150", "UPHILLCUTOFF": "2", "OFFROUTE": "0.3"},
  "familie_radrouten": {"UPHILLCOST": "80", "UPHILLCUTOFF": "3", "OFFROUTE": "0.6"},
}
TEMPLATE = pathlib.Path("src/brouter/familie.brf").read_text()
PROFILE_IDS = {}
def get(url, data=None, headers=None):
  req = urllib.request.Request(url, data=data, headers={"User-Agent": "radtour-planung", **(headers or {})})
  with urllib.request.urlopen(req, timeout=90) as r:
    return r.status, dict(r.headers), r.read().decode()

def grade_stats(coords):
  import math
  steep = 0.0; maxg = 0.0
  # 200-m-Fenster
  pts = []; acc = 0
  for i, c in enumerate(coords):
    if i: 
      a = coords[i-1]
      acc += math.hypot((c[0]-a[0])*62.0, (c[1]-a[1])*111.2) * 1000
    pts.append((acc, c[2] if len(c) > 2 else 0))
  j = 0
  for i in range(len(pts)):
    while j < len(pts) and pts[j][0] - pts[i][0] < 200: j += 1
    if j >= len(pts): break
    g = (pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]) * 100
    maxg = max(maxg, g)
  return round(maxg, 1)

out = {"routes": {}}
for name, (a, b) in TESTS.items():
  for v, params in VARIANTS.items():
    try:
      prof = "trekking"
      if params:
        if v not in PROFILE_IDS:
          txt = TEMPLATE
          for k, val in params.items(): txt = txt.replace("{{" + k + "}}", val)
          st, h, body = get("https://brouter.de/brouter/profile", data=txt.encode(), headers={"Content-Type": "text/plain"})
          j = json.loads(body)
          if "profileid" not in j: raise Exception("Upload: " + body[:300])
          PROFILE_IDS[v] = j["profileid"]
        prof = PROFILE_IDS[v]
      q = {"lonlats": f"{a[0]},{a[1]}|{b[0]},{b[1]}", "profile": prof, "alternativeidx": "0", "format": "geojson"}
      st, h, body = get("https://brouter.de/brouter?" + urllib.parse.urlencode(q, safe=",|:"))
      f = json.loads(body)["features"][0]; p = f["properties"]
      out["routes"][f"{name}/{v}"] = {"km": int(p["track-length"]) / 1000, "ascend": int(p["filtered ascend"]), "cost": int(p["cost"]), "profile": prof, "maxgrade200m": grade_stats(f["geometry"]["coordinates"])}
    except Exception as e:
      out["routes"][f"{name}/{v}"] = {"error": str(e)[:300]}
    time.sleep(1)

# CORS für GET mit Profilparametern
try:
  st, h, _ = get("https://brouter.de/brouter?lonlats=12.857,56.674|12.9,56.7&profile=" + PROFILE_IDS.get("familie", "trekking") + "&format=geojson", headers={"Origin": "https://kuchenkabel.github.io"})
  out["cors_get"] = {k: v for k, v in h.items() if k.lower().startswith("access-control")}
except Exception as e:
  out["cors_get"] = str(e)[:300]
# Eigenes Profil hochladen
try:
  prof = pathlib.Path("scripts/probe.brf").read_text() if pathlib.Path("scripts/probe.brf").exists() else "---context:global\nassign validForBikes = true\n---context:way\nassign costfactor = 1\n---context:node\nassign initialcost = 0\n"
  st, h, body = get("https://brouter.de/brouter/profile", data=prof.encode(), headers={"Origin": "https://kuchenkabel.github.io", "Content-Type": "text/plain"})
  out["upload"] = {"status": st, "body": body[:300], "cors": {k: v for k, v in h.items() if k.lower().startswith("access-control")}}
except Exception as e:
  out["upload"] = str(e)[:300]
pathlib.Path("out/routes").mkdir(parents=True, exist_ok=True)
pathlib.Path("out/routes/brouter-probe.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(json.dumps(out, ensure_ascii=False, indent=1))
