#!/usr/bin/env python3
"""Erzeugt CapacitorStorage.xml mit Testplan + Offline-Kartenpaket für den Emulator-Test."""
import json
import sys
from xml.sax.saxutils import escape

pkg = "de.familie.schwedenradtour"
uri = f"file:///data/user/0/{pkg}/files/tiles/halland.pmtiles"
line = [[12.85 + i * 0.001, 56.65 + i * 0.002, 10] for i in range(150)]
plan = {
    "version": 1, "name": "Emulator-Test", "startDate": "2027-07-10", "waypoints": [line[0], line[-1]],
    "line": line,
    "settings": {"minKm": 30, "maxKm": 50, "targetKm": 40, "restAfter": 4, "days": 21, "hmPerKm": 50, "sleepCorridorKm": 3},
    "pinned": [], "done": [], "updated": "2026-11-04T00:00:00Z",
}
prefs = {
    "tilePacks": [{"region": "halland", "path": "tiles/halland.pmtiles", "uri": uri, "bytes": int(sys.argv[1]), "date": "2026-11-04"}],
    "mapSource": "halland",
    "plan": plan,
}
items = "".join(f'<string name="{k}">{escape(json.dumps(v), {chr(34): "&quot;"})}</string>' for k, v in prefs.items())
print(f"<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>{items}</map>")
