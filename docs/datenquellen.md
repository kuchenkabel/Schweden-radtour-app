# Datenquellen für die Schweden-Radtour-App

Stand der Recherche: 2026-11-04. Hinweis: Der Sandbox-Proxy blockierte direkte API-Aufrufe (HTTP 403), `taginfo` und `brouter.de/brouter-web` sperren Robots. Punkte, die nicht live geprüft werden konnten, sind mit **[ungeprüft]** markiert und vor dem Einbau mit einem echten Request zu verifizieren.

## 1. Badeplätze (Havs- och vattenmyndigheten, HaV)

- **Es gibt eine offene API** "API Badplatser och badvatten" (OpenAPI 3, Doku als ZIP `apispec-bathing-waters-public-2.3.0.1-hav-doc.zip` auf der HaV-Seite). Abfrage nach Badeplatz-ID, z. B. `/bathing-waters/{id}` (Version 2.3.0). Die alte API wird **Herbst 2026 abgeschaltet**; die neue ("Nya Badplatsen") hat umbenannte Felder.
  - Quelle: <https://www.havochvatten.se/data-kartor-och-rapporter/data-och-statistik/data-och-apier/api-badplatser-och-badvatten.html>
  - Änderungen/Migration: <https://www.havochvatten.se/data-kartor-och-rapporter/data-och-statistik/data-och-apier/api-badplatser-och-badvatten/api-badplatser-och-badvatten/2025-05-05-oppet-api-for-badplatser-och-badvatten.html>
- **Format:** JSON (REST); Host der Plattform laut Naturkartan/Community: `gw-badplatsen.havochvatten.se` (Swagger-UI dort, für Crawler gesperrt) **[Basis-URL, Listen-Endpunkt und Beispiel-Request ungeprüft]**.
- **Felder (laut HaV-Seite):** Indikatorbakterien-Werte, Algenblüte, Badhinweise/Badeverbote, Klassifizierung, Probenahme-Koordinaten, Küstenwassertemperatur-Prognose (Copernicus, 3-stündlich); Probenhistorie 5 Jahre. Einrichtungen (Toilette, Dusche etc.) sind laut Seite nicht als Kernfeld genannt **[ungeprüft]**; Name/Gemeinde/Koordinate der Badeplatz-Stammdaten sind zu erwarten.
- **Lizenz/Bedingungen:** Kein CC0 für die Daten. Es gilt der "Avtal om användarvillkor för API:er för öppna data": nicht-exklusive, widerrufbare Nutzung; die API-*Spezifikationen* stehen unter CC0; Quellenangabe HaV erlaubt, aber keine Suggestion von HaV-Eigentum; nicht überlasten; Registrierung (Name, E-Mail, Organisation) mit User-Key möglich/nötig; Versionswechsel binnen 6 Monaten. Quelle: <https://www.havochvatten.se/download/18.ad23bfe185cbe8fec8bafa6/1675243143056/avtal-anvandarvillkor-api-oppna-data-hav.pdf>
- Naturkartan nutzt dieselbe API, nennt keine Lizenz: <https://www.naturkartan.se/en/data>
- Kein Massen-Download der Stammdaten gefunden; Statistik nur über das HaV-Data-Warehouse: <https://www.havochvatten.se/badplatser-och-badvatten/rapporter-och-oppna-data.html>. Kontakt: badvatten@havochvatten.se.

**Empfehlung:** Offline-First: Badeplatzliste einmalig (vor Reise / im Build) per API ziehen und als GeoJSON in die App packen (Name, Koordinate, Kommune, Klasse), Live-Qualität nur optional bei Netz. Als Fallback/Ergänzung OSM (`leisure=swimming_area`, `natural=beach`) nutzen. Mit Key-Registrierung rechnen und "Quelle: Havs- och vattenmyndigheten" anzeigen.

## 2. Waldbrandgefahr / Eldningsförbud

- **Brandrisk (maschinenlesbar, SMHI, "Fire Weather Index"):** API `fwif1g` (Brandriskprognoser/-analyser per Tag und Stunde).
  - Einstieg: `https://opendata-download-metfcst.smhi.se/fwif1gv1`
  - Beispiel: `https://opendata-download-metfcst.smhi.se/api/category/fwif1g/version/1/daily/geotype/point/lon/16/lat/58/data.json`
  - JSON, UTC, WGS84. Prognose 6 Tage täglich, 48 h stündlich; Analysen echtzeit; Historie ab 2021 als Download.
  - Quellen: <https://opendata.smhi.se/apidocs/fireriskforecast>, <https://www.smhi.se/data/temperatur-och-vind/brandrisk>
  - Lizenz: SMHI Open Data = CC BY 4.0 (siehe Abschnitt 3).
- **Eldningsförbud (Feuerverbot):** **Keine maschinenlesbare landesweite Quelle gefunden.** Verbote werden pro Länsstyrelse bzw. Kommune als Webseite/PDF veröffentlicht (z. B. <https://www.lansstyrelsen.se/dalarna/samhalle/sakerhet-och-beredskap/brandrisk-och-eldningsforbud.html>). Die MSB-Karte "Brandrisk ute" (github.com/Sha-Darim/brandriskute ist nur ein Inoffizielles Projekt) liefert keine offizielle Verbots-API.

**Empfehlung:** FWI-Punkt-Abfrage von SMHI als "Brandrisiko" je Etappe (mit Cache); Feuerverbot nur als Hinweistext + Link zur jeweiligen Länsstyrelse und Pflicht-Hinweis "Vor jedem Feuer lokal prüfen / Kocher statt Lagerfeuer". Im Zweifel: kein offenes Feuer.

## 3. SMHI Open Data: Vorhersage und Beobachtungen

**Punktvorhersage**
- Alt: `pmp3g` v2 (wird abgelöst): `https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/{lon}/lat/{lat}/data.json`; Parameter `ws` (m/s), `wd` (Grad), `gust`, `pmin/pmean/pmax/pmedian` (mm/h), `pcat`. Quelle: <https://opendata.smhi.se/apidocs/metfcst/parameters.html>
- Neu: **SNOW1g** v1 (Doku <https://opendata.smhi.se/metfcst/snow1gv1>, laut Praxis-Projekt MagicMirror <https://github.com/MagicMirrorOrg/MagicMirror/pull/4082/files>): Pfad `.../api/category/snow1g/version/1/geotype/point/lon/{lon}/lat/{lat}/data.json`; Parameternamen `wind_speed`, `wind_from_direction`, `precipitation_amount_mean|min|max|median`, `predominant_precipitation_type_at_surface` **[exakter Pfad/JSON-Struktur ungeprüft, da Doku-Seite per Fetch leer]**.
- **CORS:** In der Doku nicht erwähnt, nicht verifiziert **[ungeprüft]**. In Capacitor-App (native HTTP-Plugin `CapacitorHttp` verwenden) ist CORS ohnehin umgehbar; für Browser-Tests ggf. Proxy.
- **Lizenz:** CC BY 4.0 (Erkännande 4.0 SE); "Quelle: SMHI" nennen, Änderungen kenntlich machen. Keine Zahlenlimits; Caching erwünscht, nur so oft anfragen wie sich Daten ändern. Quelle: <https://www.smhi.se/data/om-smhis-data/fragor-och-svar>

**Beobachtungen (Juli-Klimatologie Wind)**
- API: Einstieg `https://opendata-download-metobs.smhi.se/api` (JSON, Hierarchie Version, Parameter, Station, Period, Data). Quelle: <https://opendata.smhi.se/apidocs/metobs>
- Parameter: **3** = Windrichtung (Stundenwert, Mittel 10 min), **4** = Windgeschwindigkeit (Stundenwert) (Nummern aus Gedächtnis/INSPIRE-Metadaten, bei erstem Abruf gegen `.../version/1.0/parameter.json` prüfen). Zeiträume `corrected-archive` (geprüft, bis ca. 3 Monate zurück) und `latest-months`; Daten als `data.csv` oder `data.json`. Muster: `.../api/version/1.0/parameter/4/station/{id}/period/corrected-archive/data.csv` **[Muster ungeprüft]**.
- Vorgehen: pro Region 1 bis 2 Stationen wählen (Station-Liste `parameter/4.json`, CORE-Stationen bevorzugen, da qualitätsgeprüft), CSV einmalig laden, Juli-Zeilen offline aggregieren (Windrose, Median m/s) und als statisches JSON mitliefern. Bulk-Regel: Stationen/Parameter nacheinander laden, selten.

**Empfehlung:** Live: SNOW1g Punktabfrage (ws/wd/Niederschlag) mit Cache, Fallback pmp3g nicht mehr einplanen. Statisch: Juli-Windstatistik vorab aus Parameter 3/4 berechnen. Lizenz-Hinweis "Daten: SMHI, CC BY 4.0".

## 4. BRouter (brouter.de)

- **Request-Format** (Quelle: <https://github.com/abrensch/brouter>):
  `https://brouter.de/brouter?lonlats=18.0686,59.3293|18.1,59.4&profile=trekking&alternativeidx=0&format=geojson` (lon,lat; Paare mit `|`/`%7C`). Ausgabe GeoJSON-LineString; Koordinaten haben als dritten Wert die Höhe (Z), so die BRouter-Praxis **[ungeprüft]**. Alternative Profile: `trekking`, `fastbike`, `safety`.
- **Nutzungsbedingungen/CORS:** Auf brouter.de und im README **keine ausdrücklichen API-Nutzungsbedingungen, kein Rate-Limit-Text und keine CORS-Aussage** gefunden (brouter-web ist als Instanz von @abrensch gehostet: <https://github.com/nrenner/brouter-web>). Wegen Robots-Sperre und Proxy nicht live getestet **[ungeprüft]**.
- Der Server wird privat betrieben: sparsam nutzen (wenige Requests, Ergebnis cachen, kein Dauerpolling), freundlich bleiben.

**Empfehlung:** Routen **vorab** (Build-Zeit/Skript) per BRouter berechnen und als GPX/GeoJSON in die App einbetten; kein Live-Routing zur Laufzeit nötig. Bei Bedarf eigenen BRouter-Server (Docker, Segmente `.rd5` für Schweden) hosten statt brouter.de zu belasten.

## 5. Vektorkacheln für MapLibre (privat, nicht kommerziell, offline)

| Option | Offline-Extrakt? | Bedingungen |
|---|---|---|
| **Protomaps PMTiles** (Daily Build, Planet ~120 GB, z0-15) | **Ja**, `pmtiles extract` | ODbL-Produced-Work, OSM-Attribution Pflicht; Hosted API braucht Key, ca. 1 Mio. Requests/Monat Soft-Limit, kommerziell GitHub-Sponsor. Quellen: <https://docs.protomaps.com/basemaps/downloads>, <https://protomaps.com/faq> |
| **VersaTiles** (`osm.versatiles`, 62 GB, z0-14, Shortbread-Schema; Download als .versatiles/.pmtiles/.mbtiles, Bbox wählbar) | **Ja** | OSM-Attribution (ODbL). Quelle: <https://download.versatiles.org/> |
| **OpenFreeMap** | Nur kleine Offline-Downloads: max. 3000 Kacheln bzw. 50 MB, 4 parallele Requests, eigener User-Agent; mehr nach Rücksprache | Kostenlos, ohne Key, kommerziell ok; Attribution (OpenMapTiles + OSM, MapLibre automatisch). Quelle: <https://openfreemap.org/> |
| **MapTiler Free** | **Nein** (Bulk-Download und Export ohne Schriftform verboten) | Free Plan nur nicht-kommerziell, MapTiler-Attribution. Quelle: <https://www.maptiler.com/cloud/terms/> |

- **Befehl:** `pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles schweden.pmtiles --bbox=10.9,55.2,24.2,69.1 --maxzoom=14` (Quelle: <https://docs.protomaps.com/pmtiles/cli>; Build-Liste: <https://maps.protomaps.com/builds>). Quelle muss "clustered" sein; jeder zusätzliche Zoom verdoppelt etwa die Größe.
- **Größe Schweden z0-14:** nicht veröffentlicht; **Schätzung** (Hochrechnung aus Planet z0-14 ca. 60 GB und dem Flächen-/Datenanteil) grob 1 bis 2 GB für ganz Schweden. Für Tour-Korridor (Bbox oder Etappen-Buffer von ca. 30 km) typischerweise 50 bis 200 MB. Auf Gerät `maxzoom=13` oder 14 nur im Korridor.
- **Attribution (Pflicht):** "© OpenStreetMap contributors" (ODbL) sichtbar auf der Karte; bei Protomaps-Basemap-Style zusätzlich "Protomaps" üblich.

**Empfehlung:** **Protomaps PMTiles** (Daily Build per `pmtiles extract` auf Tour-Korridor, in Capacitor-Assets/Dateisystem, MapLibre mit `pmtiles://`-Protokoll) – keine Abhängigkeit zur Laufzeit, Lizenz klar. VersaTiles als Plan B. OpenFreeMap nur als Online-Fallback beim Entwickeln.

## 6. OSM-Tags: STF-Herbergen und Vindskydd

- **STF-Herbergen:** Beleg am Objekt "Hemavan Fjällstation": `tourism=hostel`, `operator=Svenska Turistföreningen`, `brand=STF`, `brand:wikidata=Q1492844` (<https://www.openstreetmap.org/way/490601230>). Fjällstugor (z. B. Sälka): `operator=Svenska Turistföreningen`, vermutlich `tourism=alpine_hut` (<https://www.openstreetmap.org/node/1356403616>). Es ist **nicht einheitlich**: manche Betriebe nur `operator=STF` oder ohne brand; Overpass-Filter daher tolerant: `brand:wikidata=Q1492844` ODER `operator~"Svenska Turistf|STF"` ODER `name~"^STF "`, in `tourism=hostel|hotel|chalet|alpine_hut`. Counts nicht prüfbar (taginfo blockiert).
- **Vindskydd:** Das Standard-Tagging nach OSM-Wiki ist `amenity=shelter` + `shelter_type=lean_to` ("Schuppen mit meist drei Wänden, zum Campen"): <https://wiki.openstreetmap.org/wiki/Tag:shelter_type=lean_to>. Daneben existieren `shelter_type=basic_hut` und `tourism=wilderness_hut` (mit Ofen/Kamin): <https://wiki.openstreetmap.org/wiki/Tag:tourism=wilderness_hut>. Schwedische Mapper-Diskussion: <https://lists.openstreetmap.org/pipermail/talk-se/2012-October/001682.html>. Auch Abfrage `amenity=shelter` ohne shelter_type einbeziehen, plus `name~"[Vv]indskydd"`.

**Empfehlung:** Einmalig per Overpass (Schweden-Bbox oder Korridor) extrahieren und als statische GeoJSON-Layer in die App legen; Filter breit wählen (siehe oben) und Ergebnisse vor Reise stichprobenartig gegen STF-Website prüfen. Selbe Daten stecken im PMTiles-Basemap nur teilweise, daher eigener POI-Extrakt.

## Gesamtempfehlung

Offline vorab bauen: PMTiles-Korridor, BRouter-Routen, POI-Extrakt (Overpass), Badeplatz-Snapshot, Juli-Windstatistik. Live nur (optional, mit Cache): SMHI SNOW1g und FWI, HaV-Badequalität. Attribution-Seite in der App: OpenStreetMap (ODbL), SMHI (CC BY 4.0), Havs- och vattenmyndigheten, Protomaps. Feuerverbot nur als manueller Hinweis.
