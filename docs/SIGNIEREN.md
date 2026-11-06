# App-Signatur (Updates ohne Deinstallieren)

Android installiert ein Update nur über die vorhandene App, wenn beide APKs mit
**demselben Schlüssel** signiert sind. Der Build (`.github/workflows/apk.yml`)
nutzt dafür einen festen Release-Schlüssel aus zwei GitHub-Secrets:

| Secret | Inhalt |
|---|---|
| `KEYSTORE_B64` | Keystore-Datei (PKCS12, Alias `radtour`), Base64-kodiert |
| `KEYSTORE_PASSWORD` | Passwort für Keystore und Schlüssel |

Fingerabdruck (SHA-256) des Schlüssels:
`A3:30:2F:2F:1F:AE:7C:58:49:29:33:DC:AF:E3:2B:45:25:FB:95:AD:5C:99:F6:B8:76:23:AA:A9:CA:78:4C:24`

Der Build prüft diesen Fingerabdruck und bricht ab, wenn er nicht passt.
Fehlen die Secrets, wird mit einem wechselnden Debug-Schlüssel signiert
(dann muss vor jedem Update deinstalliert werden).

Der Keystore liegt **nicht** im Repo (öffentlich). Sicherungskopie privat
aufbewahren: Geht er verloren, muss die App einmal deinstalliert werden
(Daten weg) und ein neuer Schlüssel angelegt werden.
