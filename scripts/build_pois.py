#!/usr/bin/env python3
"""Wandelt einen osmium-GeoJSON-Seq-Export in die kompakte POI-Datei der App um.

Aufruf: build_pois.py <eingabe.geojsonseq> <ausgabe.json>
Ausgabeformat (Version 1):
  {"v":1,"generated":"YYYY-MM-DD","source":"...","cats":[...],
   "pois":[[catIndex, lat_e5, lon_e5, name, {extras}], ...]}
lat/lon sind Ganzzahlen in 1e-5 Grad (ca. 1 m Genauigkeit).
"""
import datetime
import json
import sys

CATS = [
    "vindskydd", "huette", "camping", "stf", "hostel", "badplats", "spielplatz",
    "wasser", "wc", "supermarkt", "radladen", "gas", "apotek", "vard", "bahnhof",
    "unterstand",
]
CAT_INDEX = {c: i for i, c in enumerate(CATS)}

# Tags, die in der App angezeigt werden (Kurzschlüssel spart Platz).
EXTRA_TAGS = {
    "opening_hours": "oh", "website": "web", "contact:website": "web", "phone": "tel",
    "contact:phone": "tel", "operator": "op", "fee": "fee", "drinking_water": "dw",
    "toilets": "wc", "shower": "sh", "washing_machine": "wm", "reservation": "res",
    "tents": "tent", "capacity": "cap", "fireplace": "fire", "bicycle": "bike",
    "wheelchair": "rs", "description": "desc", "access": "acc",
    "check_date": "chk", "survey:date": "chk", "shelter_type": "typ",
}

# Unterstände, die nie ein Schlafplatz sind (Bushaltestelle, Viehunterstand, Umkleide ...).
SHELTER_SKIP = {
    "public_transport", "field_shelter", "changing_rooms", "parking", "sun_shelter",
    "rock_shelter", "bicycle_parking", "smoking_shelter",
}
VINDSKYDD_WORDS = ("vindskydd", "windskydd", "slogbod", "kåta")

STF_MARKERS = ("stf", "svenska turistföreningen", "svenska turistforeningen")


def classify(t):
    a = t.get("amenity")
    if a == "shelter":
        return classify_shelter(t)
    tour = t.get("tourism")
    if tour == "camp_site":
        return "camping"
    if tour in ("wilderness_hut", "alpine_hut"):
        return "huette"
    if tour == "hostel":
        hay = " ".join(t.get(k, "") for k in ("operator", "brand", "name", "network")).lower()
        return "stf" if any(m in hay for m in STF_MARKERS) else "hostel"
    lei = t.get("leisure")
    if lei in ("bathing_place", "swimming_area"):
        return "badplats"
    if lei == "playground":
        return "spielplatz"
    if a in ("drinking_water", "water_point"):
        return "wasser"
    if a == "toilets":
        return "wc"
    if a == "pharmacy":
        return "apotek"
    if a in ("clinic", "hospital") or t.get("healthcare") in ("centre", "hospital"):
        return "vard"
    shop = t.get("shop")
    if shop in ("supermarket", "convenience"):
        return "supermarkt"
    if shop == "bicycle":
        return "radladen"
    if shop in ("outdoor", "sports", "hardware", "doityourself"):
        return "gas"
    if t.get("railway") in ("station", "halt"):
        if t.get("station") in ("subway", "light_rail", "monorail") or t.get("subway") == "yes":
            return None
        if t.get("usage") == "tourism" or t.get("disused") == "yes":
            return None
        return "bahnhof"
    return None


def classify_shelter(t):
    """Nur echte Windschutzhütten zählen als Vindskydd.

    Früher zählte jeder Unterstand (auch Picknickdächer und Einträge ohne Typ);
    bei Stichproben war dort oft keine Hütte. Unklare Fälle werden jetzt
    "unterstand" (unsicher) und sind in der App standardmäßig ausgeblendet.
    """
    st = t.get("shelter_type")
    if st in SHELTER_SKIP:
        return None
    if t.get("access") in ("private", "no") or t.get("disused") == "yes":
        return None
    if any(k.startswith(("disused:", "abandoned:", "demolished:", "razed:")) for k in t):
        return None
    if st in ("lean_to", "basic_hut"):
        return "vindskydd"
    name = (t.get("name") or t.get("name:sv") or "").lower()
    if any(w in name for w in VINDSKYDD_WORDS):
        return "vindskydd"
    return "unterstand"


def centroid(geom):
    typ, coords = geom["type"], geom["coordinates"]
    if typ == "Point":
        return coords[1], coords[0]
    pts = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                walk(x)

    walk(coords)
    if not pts:
        return None
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def main(src, dst):
    pois, seen = [], set()
    counts = {c: 0 for c in CATS}
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            feat = json.loads(line)
            t = feat.get("properties") or {}
            cat = classify(t)
            if not cat or not feat.get("geometry"):
                continue
            c = centroid(feat["geometry"])
            if not c:
                continue
            lat, lon = round(c[0] * 1e5), round(c[1] * 1e5)
            key = (cat, lat // 20, lon // 20)  # Dubletten (Knoten + Fläche) auf ~20 m zusammenlegen
            if key in seen:
                continue
            seen.add(key)
            extras = {}
            for tag, short in EXTRA_TAGS.items():
                if tag in t and short not in extras:
                    extras[short] = t[tag][:200]
            if cat == "bahnhof" and "operator" in t:
                extras["op"] = t["operator"]
            name = t.get("name") or t.get("name:sv") or ""
            pois.append([CAT_INDEX[cat], lat, lon, name] + ([extras] if extras else []))
            counts[cat] += 1
    out = {
        "v": 1,
        "generated": datetime.date.today().isoformat(),
        "source": "© OpenStreetMap-Mitwirkende, ODbL",
        "cats": CATS,
        "pois": pois,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    for c in CATS:
        print(f"{c:12s} {counts[c]:7d}")
    print(f"{'gesamt':12s} {len(pois):7d}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
