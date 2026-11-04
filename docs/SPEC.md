# Spezifikation Version 1: Schweden-Radtour-App

Stand: 2026-11-04. Grundlage: Konzept-PDF "Planungs-Checkliste Schweden-Radtour mit Familie" und der abgestimmte Plan.

## Ziel

Eine deutschsprachige Android-App (APK) für eine 3-wöchige Familien-Radtour in Schweden im Juli/August 2027:
2 Erwachsene (einer mit Anhänger und Kleinkind), ein 13-jähriges und ein 8-jähriges Kind auf eigenen Rädern.
Die App hilft **jetzt beim Planen** (Region wählen, Route und Etappen) und **unterwegs offline**.
Navigation Abbiegung für Abbiegung übernimmt OsmAnd oder Organic Maps.

## Modus "Planen" (zu Hause, online)

| Nr | Feature | Version 1 |
| --- | --- | --- |
| P1 | **Regionen-Vergleich**: Karte Schweden mit Regionen (Län bzw. bekannte Radrouten wie Kattegattleden, Sydostleden, Banvallsleden). Pro Region: Anzahl Badestellen, Vindskydd, Campingplätze, STF-Häuser, Bahnhöfe mit Rad-Mitnahme je 100 km Route, typischer Juli-Wind | Ja |
| P2 | **Route erstellen**: Start und Ziel antippen, Zwischenpunkte setzen, Fahrrad-Routing über BRouter (Profil "Trekking", Familien-tauglich: Radwege und ruhige Straßen bevorzugt) | Ja |
| P3 | **GPX importieren** (z.B. aus Komoot) als Alternative zu P2 | Ja |
| P4 | **Etappenplaner**: Route in Tagesetappen teilen. Standard 30 bis 50 km, Ziel ca. 40 km, Ruhetag alle 4 bis 5 Tage, 21 Tage gesamt. Jede Etappe endet an einem Schlafplatz-Kandidaten (Vindskydd, Camping, STF). Mittagspause-Vorschlag an einer Badestelle nach ca. 55 % der Etappe | Ja |
| P5 | **Etappe von Hand verschieben**: Etappenende auf einen anderen Schlafplatz ziehen, Rest wird neu verteilt | Ja |
| P6 | **Höhenprofil** pro Etappe, Warnung bei mehr als 400 Höhenmetern am Tag | Ja |
| P7 | **Plan teilen**: Plan als Datei exportieren und auf anderen Handys importieren (Teilen-Menü, z.B. per Messenger) | Ja |
| P8 | **Offline-Paket laden**: Kartenkacheln für den Korridor der Route (ca. 10 km beidseitig) herunterladen | Ja |
| P9 | Fähren nach Schweden mit Anhänger-Hinweisen als Info-Liste | Ja |

## Modus "Unterwegs" (offline)

| Nr | Feature | Version 1 |
| --- | --- | --- |
| U1 | Offline-Karte mit Route, eigener Position und heutiger Etappe | Ja |
| U2 | **"Was kommt als Nächstes"**: Liste entlang der Route ab aktueller Position: nächste Badestelle, Spielplatz, Trinkwasser, WC, Supermarkt, Vindskydd, Camping. Mit Entfernung in km auf der Route | Ja |
| U3 | POI-Filter auf der Karte (Ebenen ein/aus) | Ja |
| U4 | POI-Details: Öffnungszeiten, Ausstattung (z.B. Waschmaschine, Zeltwiese) soweit in OSM vorhanden, Link zur Webseite | Ja |
| U5 | **Bail-out**: nächste Bahnhöfe mit Rad-Mitnahme und Regel des Verkehrsverbunds. Kein Verbund erlaubt laut Recherche ausdrücklich Kinderanhänger, daher zusätzlich Großraumtaxi ("storbil") als Option für Anhänger + Kleinkind | Ja |
| U6 | **Notfall**: nächstes Apotek und Vårdcentral, 112, 1177 Vårdguiden, Notfallkarte pro Person (Allergien, Medikamente, Blutgruppe), Standort als SMS teilen | Ja |
| U7 | **Wetter und Wind** (wenn Netz da): SMHI-Prognose für heute und morgen, Gegenwind auf der Etappe, geschätzte machbare km ("Gegenwind 6 m/s: eher 30 km") | Ja |
| U8 | **Feuerverbot**: SMHI-Brandrisiko (Fire Weather Index, maschinenlesbar) plus Link zum Eldningsförbud der Länsstyrelse (kein offener Datendienst) | Ja |
| U9 | In OsmAnd/Organic Maps öffnen (Etappe als GPX übergeben) | Ja |
| U10 | Tages-Erinnerungen 15:30: "Camp aufbauen, Wasser auffüllen, Zeckencheck" | Ja |
| U11 | Countdown zur nächsten Badestelle groß auf dem Startbildschirm (für die Kinder) | Ja |

## Immer verfügbar

| Nr | Feature | Version 1 |
| --- | --- | --- |
| A1 | **Packliste** aus dem Konzept-PDF, abhakbar, eigene Punkte hinzufügen, offline gespeichert | Ja |
| A2 | Vor-der-Tour-Checkliste (Pässe, EHIC, STF-Mitgliedschaft, FSME-Impfung, Fähre buchen) mit Fälligkeitsdatum | Ja |
| A3 | Xiaomi-Hilfe: Anleitung, Akku-Optimierung und Autostart für die App freizugeben | Ja |

## Später (nicht Version 1)

- Tagebuch mit km, Foto und Notiz pro Tag
- Live-Abgleich zwischen den Handys (Version 1: Datei teilen)
- Eigenes Offline-Routing ohne Netz
- Stempel/Belohnungen für die Kinder

## Daten

| Daten | Quelle | Wie |
| --- | --- | --- |
| POIs ganz Schweden | OpenStreetMap (Geofabrik-Extrakt Schweden) | Wird per GitHub Actions monatlich gefiltert und als kompakte Datei (SQLite oder GeoJSON, Ziel unter 30 MB) in die App gepackt |
| Badestellen | OSM `leisure=bathing_place` und `swimming_area`. HaV-Daten (Wasserqualität) erst später: Nutzungsbedingungen und API-Schlüssel nötig, siehe [datenquellen.md](datenquellen.md) | Wie oben |
| Kartenkacheln | Protomaps/OpenMapTiles-kompatible Vektorkacheln (PMTiles) | Planen: online. Unterwegs: Korridor-Download (P8) |
| Routing | BRouter (öffentlicher Server, online) | Nur im Planungsmodus |
| Höhen | BRouter liefert Höhen mit der Route | Mit P2; bei GPX-Import aus der Datei |
| Wetter und Wind | SMHI Open Data API | Online, letzter Abruf gecacht |
| Juli-Wind je Region | SMHI historische Daten | Einmalig ausgewertet, als Tabelle in der App |
| Rad/Anhänger im Zug | Eigene Recherche je Verkehrsverbund: [data/transport-rules.json](../data/transport-rules.json) | Tabelle in der App, Stand mit Datum |

OSM-Kategorien: `amenity=shelter` (shelter_type=lean_to/weather_shelter), `tourism=camp_site`, `tourism=hostel` (STF über operator/brand), `leisure=bathing_place`, `leisure=playground`, `amenity=drinking_water`, `amenity=toilets`, `shop=supermarket|convenience`, `shop=bicycle`, `shop=outdoor|hardware|sports` (Gaskartuschen), `amenity=pharmacy`, `healthcare=centre|amenity=clinic`, `railway=station`.

## Technik

- TypeScript, Vite, MapLibre GL JS, PMTiles
- Capacitor für Android (minSdk 26 = Android 8), Geolocation, Filesystem, Local Notifications, Share
- Datenhaltung lokal (IndexedDB/SQLite), keine Anmeldung, kein Server
- Build: GitHub Actions baut Datenpaket und APK; die APK liegt als Release-Datei im Repo zum Herunterladen
- Signierte Release-APK mit eigenem Schlüssel (als GitHub-Secret), damit Updates sich über die alte Version installieren lassen

## Offene Punkte (kläre ich in Schritt 2)

- Lizenz und Format der Badestellen-Daten der Havs- och vattenmyndigheten
- Ob es eine abrufbare Quelle für Eldningsförbud gibt; sonst nur Link
- Anhänger-Regeln je Verkehrsverbund (Skånetrafiken, Västtrafik, Östgötatrafiken, SJ u.a.)
- Nutzungsbedingungen des öffentlichen BRouter-Servers und eines Kachel-Anbieters für die Planung
