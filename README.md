# Schwerer Autodiebstahl

Kleines Open-World-Multiplayer-Spiel für den **Handy-Browser**, gedacht für dich und 5 bis 10 Freunde.
Man läuft über eine kleine Stadt, spawnt Autos und Flugzeuge und schießt. Alles ist für **Touch** gebaut
(Joystick links, Kamera-Wischen und Buttons rechts), am Rechner geht es auch mit Tastatur.

- Kostet nichts: Browser-Spiel, Open-Source-Werkzeuge, keine Store-Gebühren.
- Ein einziger Node.js-Prozess ist Webserver und Spielserver. Freunde bekommen nur einen Link.
- Der Server entscheidet über Bewegung, Spawns, Treffer und Schaden (Clients können nicht schummeln).

## Schnellstart

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm run build     # baut den Client nach dist/
npm start         # Server auf http://localhost:8080
```

Öffne `http://<deine-PC-IP>:8080` auf dem Handy (gleiches WLAN), gib Namen und Raumcode ein. Standard-Raumcode: `freunde`.
Einstellungen per Umgebungsvariable:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8080` | Port des Servers |
| `ROOM_CODE` | `freunde` | Raumcode (leer = kein Code) |
| `MAX_PLAYERS` | `10` | Maximale Spielerzahl |

Beispiel: `ROOM_CODE=geheim123 npm start`. Mit `?room=geheim123` in der URL ist der Code vorausgefüllt.

### Entwickeln

```bash
npm run dev       # Vite (Port 5173) und Server (Port 8080) zusammen, mit Live-Reload
npm run typecheck # TypeScript prüfen
npm run smoke     # Bot-Test gegen den laufenden Server (frischer Server, Raumcode freunde)
```

Am Handy im WLAN: `http://<deine-PC-IP>:5173`.

## Mit Freunden außerhalb deines WLANs spielen (kostenlos)

Der Server läuft auf deinem PC (oder einem Raspberry Pi). Für einen öffentlichen https-Link ohne Router-Einstellungen
eignet sich ein Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

Das Programm gibt eine `https://…trycloudflare.com`-Adresse aus, die du den Freunden schickst (WebSocket läuft über `wss`
automatisch mit). Die Adresse ändert sich bei jedem Start, dafür braucht es keinen Account. Prüfe die aktuellen Bedingungen
von Cloudflare, bevor du dich darauf verlässt. Das Spiel läuft nur, solange dein Rechner und der Server an sind.

Tipp für Handys: im Browser-Menü „Zum Home-Bildschirm" wählen, dann startet das Spiel im Vollbild.

## Steuerung

| | Touch | Tastatur (Test am Rechner) |
| --- | --- | --- |
| Laufen, Lenken | Joystick links (erscheint, wo der Daumen aufsetzt) | WASD oder Pfeile |
| Umsehen | Wischen rechts, auch über dem Feuer-Button | Maus ziehen |
| Schießen | Feuer-Button halten | Leertaste |
| Ein- und Aussteigen | Button „Einsteigen" (nächstes freies Fahrzeug) | E |
| Auto oder Flugzeug spawnen | „Spawn", dann Auto oder Flugzeug | C (Auto), V (Flugzeug) |
| Waffe wechseln | „Waffe" (Pistole, Sturmgewehr, Raketenwerfer) | Q |
| Flugzeug | Joystick hoch = Nase hoch, links/rechts = Kurve; Schubregler am Rand | R/F = mehr/weniger Schub |

Das Flugzeug hebt ab ab etwa 70 km/h. Es spawnt in der Richtung mit der längsten freien Strecke vor dir; gibt es keine,
steht es am Flugplatz (breite Straße nach Osten). Im Flugzeug schießt man mit der Bordkanone.

## Aufbau

```
client/   Browser-Client (Three.js, Vite): Welt, Touch-Steuerung, HUD
server/   Spielserver (Node.js, ws): Simulation, Treffer, Spawns, liefert dist/ aus
shared/   Karte und Bewegungslogik, von Server und Client gemeinsam genutzt
scripts/  smoke.ts: Bot-Test
```

Netzwerk in Kurzform: Der Client schickt 30 mal pro Sekunde seine Eingaben und sagt seine eigene Bewegung mit derselben
Funktion (`shared/sim.ts`) voraus. Der Server rechnet nach, schickt 20 Snapshots pro Sekunde und bestätigt jede Eingabe;
weicht der Client ab, wird er korrigiert. Andere Spieler werden mit 100 ms Puffer weich interpoliert.

## Stand und Grenzen

Spielbarer Prototyp. Noch nicht umgesetzt: Beifahrer-Sitze, Lag-Kompensation beim Schießen, Sounds, Konten und
Speicherstand, eigene Modelle (alles sind einfache Klötze, es werden keine fremden Assets verwendet).
Beim Gestalten bitte keine fremden Marken oder Logos verwenden.

## Lizenz

GNU General Public License v3 (siehe `LICENSE`). Eingesetzte Bibliotheken: Three.js (MIT), ws (MIT).
