# Schweden-Radtour-App

Offline-first Android-App zum Planen und Fahren einer Familien-Radtour in Schweden (Juli/August 2027).

## App installieren (Xiaomi Redmi)

1. Auf dem Handy diese Seite öffnen und die neueste APK laden:
   **https://github.com/kuchenkabel/schweden-radtour-app/releases/download/apk-latest/schweden-radtour.apk**
2. Datei öffnen. Beim ersten Mal fragt Android, ob der Browser „unbekannte Apps installieren“ darf: erlauben.
   Xiaomi zeigt eventuell eine Sicherheitsprüfung, dann „Trotzdem installieren“.
3. App öffnen, Standort erlauben („Bei Nutzung der App“, genau).
4. Unter **Mehr → Xiaomi-Handys einrichten** die Akku-Einstellungen anpassen.
5. Vor der Abfahrt im WLAN: **Mehr → Offline-Karten** die Region(en) laden.

Plan auf ein anderes Handy übertragen: **Planen → Plan teilen**, Datei z.B. per Messenger schicken,
auf dem anderen Handy **Planen → Plan importieren**.

## Was die App kann

- **Planen:** Regionen vergleichen (Badestellen, Vindskydd, Camping, Bahnhöfe), Route per Fahrrad-Routing
  (BRouter) oder GPX-Import, Aufteilung in Tagesetappen (30–50 km, Höhenmeter eingerechnet, Ruhetage),
  Schlafplatz je Etappe von Hand ändern, Plan teilen.
- **Unterwegs:** Countdown zur nächsten Badestelle, „Was kommt als Nächstes“, Wetter und Gegenwind (SMHI)
  mit Schätzung der machbaren km, Brandrisiko, Abbruch-Plan mit Bahnhöfen und Zugregeln, Etappe an OsmAnd/Organic Maps.
- **Listen:** Vor-der-Tour-Aufgaben mit Fälligkeitsdatum, Packliste, eigene Punkte.
- **Notfall:** 112/1177, nächste Apotheke und Vårdcentral, Notfallkarten pro Person, Standort per SMS, Sätze auf Schwedisch.

Spezifikation: [docs/SPEC.md](docs/SPEC.md) · Datenquellen: [docs/datenquellen.md](docs/datenquellen.md)

## Entwicklung

```bash
npm ci
npm run fetch-data   # POIs (Release data-latest) und Kartenschriften nach public/
npm run dev          # im Browser
npm test
```

GitHub Actions:

| Workflow | Was |
| --- | --- |
| Datenpaket Schweden | POIs aus OpenStreetMap, monatlich → Release `data-latest` |
| Offline-Kartenpakete | PMTiles je Region aus Protomaps → Release `tiles-latest` (manuell starten) |
| Android-APK | baut die APK bei jedem Push → Release `apk-latest` |
| Emulator-Test | startet die APK im Android-Emulator, prüft Offline-Karte → Release `test-results` |

### Signierschlüssel

Ohne Secrets wird die APK mit einem wechselnden Debug-Schlüssel signiert. Dann lässt sich eine neue Version
nicht über die alte installieren (vorher Plan teilen/sichern, alte App deinstallieren).
Mit den Repository-Secrets `KEYSTORE_B64` (Keystore, base64) und `KEYSTORE_PASSWORD` baut der Workflow
eine fest signierte Release-APK, die sich als Update installieren lässt.

## Daten und Lizenzen

© OpenStreetMap-Mitwirkende (ODbL) · Karten: Protomaps, OpenFreeMap · Routing: BRouter ·
Wetter und Brandrisiko: SMHI (CC BY 4.0) · Zugregeln: eigene Recherche, Stand 2026-11, vor der Reise prüfen.
