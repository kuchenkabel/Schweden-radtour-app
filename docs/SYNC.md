# Sync zwischen Laptop und Handy

Plan (Route, Etappen, Einstellungen), Packliste und Personen/Notfalldaten werden über eine Datei
(`radtour-sync.json`) in einem **privaten** GitHub-Repo abgeglichen. Gerätesachen wie Kartenpakete,
Kartenhöhe oder der Esri-Schlüssel bleiben auf dem jeweiligen Gerät.

## Einmalig einrichten

1. **Privates Repo anlegen**: https://github.com/new → Name z. B. `radtour-daten`, Sichtbarkeit **Private**.
2. **Token anlegen**: https://github.com/settings/personal-access-tokens/new (fine-grained)
   - Ablaufdatum: möglichst nach der Tour (Sommer 2027). Läuft es vorher ab, einfach neu erzeugen
     und auf beiden Geräten neu verbinden.
   - Repository access: **Only select repositories** → `radtour-daten`
   - Repository permissions: **Contents: Read and write** (Metadata: Read wird automatisch gesetzt)
3. **Erstes Gerät** (z. B. Laptop, WebApp): Mehr → Sync → „Erstes Gerät: Repo und Token eingeben“,
   Repo als `besitzer/radtour-daten` und das Token eintragen, „Verbinden“.
4. Dort „Sync-Code fürs andere Gerät“ tippen. Der Code (beginnt mit `RT1-`) liegt in der Zwischenablage.
   Ihn z. B. per Messenger an dich selbst schicken.
5. **Zweites Gerät** (Handy-App): Mehr → Sync → Sync-Code einfügen → „Mit Sync-Code verbinden“.

Der Sync-Code enthält das Token. Nur an eigene Geräte geben. Wenn er in falsche Hände gerät:
Token auf GitHub löschen, ein neues anlegen und neu verbinden.

## Wie es abläuft

- Beim Start der App, beim Zurückwechseln in die App und nach jeder Änderung (nach 3 Sekunden)
  wird abgeglichen. Ohne Internet wird es nachgeholt.
- Wurde nur auf einem Gerät geändert, übernimmt das andere den Stand automatisch.
- Wurde auf **beiden** Geräten geändert, fragt die App, welcher Stand gelten soll. Der andere Stand
  bleibt in der Versionsgeschichte des Repos erhalten (jeder Abgleich ist ein Commit).
- Verbindet man ein Gerät, das schon einen eigenen Plan hat, fragt die App ebenfalls nach.

## Fehlermeldungen

- „Token darf nur lesen“: beim Token „Contents: Read and write“ einstellen (Token lässt sich nachträglich bearbeiten).
- „Repo nicht gefunden“: Schreibweise `besitzer/name` prüfen und ob das Token für dieses Repo freigegeben ist.
- „Token ungültig oder abgelaufen“: neues Token anlegen und neu verbinden.
