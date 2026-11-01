# Schwerer Autodiebstahl

Kleines Open-World-Multiplayer-Spiel für den **Handy-Browser**, gedacht für dich und 5 bis 10 Freunde.
Man läuft durch eine kleine Stadt, spawnt Autos und Flugzeuge und schießt. Alles ist für **Touch** gebaut
(Joystick links, Kamera-Wischen und Buttons rechts), am Rechner geht es auch mit Tastatur.

- Kostet nichts: Browser-Spiel, Open-Source-Werkzeuge, CC0-Grafiken, keine Store-Gebühren.
- Ein einziger Node.js-Prozess ist Webserver und Spielserver. Freunde bekommen nur einen Link.
- Der Server entscheidet über Bewegung, Spawns, Treffer und Schaden (Clients können nicht schummeln).
- **Auf dem Tablet oder Handy (Termux) braucht es nur Node.js:** das fertige Spiel liegt im Ordner `release/`.

## Auf dem Tablet hosten (Termux)

Auf dem Tablet wird **nichts gebaut und nichts per `npm install` geladen**. Gerade Vite, tsx und andere Build-Werkzeuge
machen unter Android oft Ärger, deshalb liegen Server (eine einzige Datei) und Client fertig in `release/`.

```bash
pkg update
pkg install nodejs git
git clone https://github.com/Flxx94/Schwerer-Autodiebstahl-GTA
cd Schwerer-Autodiebstahl-GTA
git checkout claude/spielbarer-prototyp   # nur nötig, solange der Branch nicht in main übernommen ist
node release/server.mjs
```

Der Server schreibt, unter welcher Adresse er im WLAN erreichbar ist, z. B. `http://192.168.1.23:8080`.
Diese Adresse öffnest du auf den Handys deiner Freunde (gleiches WLAN, oder sie hängen im Hotspot des Tablets).
Beim Start fragt das Spiel nach Namen und Raumcode (Standard: `freunde`).

- Eigener Raumcode: `ROOM_CODE=geheim node release/server.mjs`
- Anderer Port: `PORT=3000 node release/server.mjs`
- Aktualisieren: `git pull`
- Zeigt der Server keine WLAN-Adresse, nimm die Adresse aus `ip addr` (Eintrag `wlan0`, Zeile `inet`).
- Damit Android Termux nicht einschlafen lässt: `termux-wake-lock` ausführen, Termux in den Akku-Einstellungen von der
  Optimierung ausnehmen und das Tablet am Strom lassen.
- Außerhalb des WLANs: siehe Abschnitt „Mit Freunden außerhalb“ weiter unten.

Klappt etwas nicht, schick die Fehlermeldung aus Termux, dann lässt sich die Ursache finden.

## Auf dem Rechner (Entwickeln)

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm run build     # baut Client und Server nach release/
npm start         # Server auf http://localhost:8080
```

```bash
npm run dev       # baut bei jeder Änderung neu und startet den Server neu
npm run typecheck # TypeScript prüfen
npm run smoke     # Bot-Test gegen den laufenden Server (frischer Server, Raumcode freunde)
```

Der Ordner `release/` gehört absichtlich ins Repository (damit Termux nichts bauen muss). Nach Code-Änderungen
einmal `npm run build` ausführen und `release/` mit einchecken.

Einstellungen per Umgebungsvariable:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8080` | Port des Servers |
| `ROOM_CODE` | `freunde` | Raumcode (leer = kein Code) |
| `MAX_PLAYERS` | `10` | Maximale Spielerzahl |

Mit `?room=geheim` in der URL ist der Raumcode vorausgefüllt.

## Mit Freunden außerhalb deines WLANs spielen (kostenlos)

Für einen öffentlichen https-Link ohne Router-Einstellungen eignet sich ein Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

Das Programm gibt eine `https://…trycloudflare.com`-Adresse aus, die du den Freunden schickst (WebSocket läuft über `wss`
automatisch mit). Die Adresse ändert sich bei jedem Start, dafür braucht es keinen Account. Ob es `cloudflared` als
Termux-Paket gibt und welche Bedingungen gerade gelten, habe ich nicht geprüft. Das Spiel läuft nur, solange Gerät und
Server an sind.

Tipp für Handys: im Browser-Menü „Zum Home-Bildschirm“ wählen, dann startet das Spiel im Vollbild.

## Steuerung

| | Touch | Tastatur (Test am Rechner) |
| --- | --- | --- |
| Laufen, Lenken | Joystick links (erscheint, wo der Daumen aufsetzt) | WASD oder Pfeile |
| Umsehen | Wischen rechts, auch über dem Feuer-Button | Maus ziehen |
| Schießen | Feuer-Button halten | Leertaste |
| Ein- und Aussteigen | Button „Einsteigen“ (nächstes freies Fahrzeug) | E |
| Auto oder Flugzeug spawnen | „Spawn“, dann Auto oder Flugzeug | C (Auto), V (Flugzeug) |
| Waffe wechseln | „Waffe“ (Pistole, Sturmgewehr, Raketenwerfer) | Q |
| Flugzeug | Joystick hoch = Nase hoch, links/rechts = Kurve; Schubregler | R/F = mehr/weniger Schub |

Das Flugzeug hebt ab ca. 70 km/h ab. Es spawnt vor dir in der Richtung mit der längsten freien Strecke; gibt es keine,
steht es am Flugplatz (breite Straße nach Osten). Im Flugzeug schießt man mit der Bordkanone.

## Aufbau

```
client/   Browser-Client (Three.js): Welt, Touch-Steuerung, HUD, Modelle laden
server/   Spielserver (Node.js, ws): Simulation, Treffer, Spawns, liefert den Client aus
shared/   Karte und Bewegungslogik, von Server und Client gemeinsam genutzt
scripts/  build.mjs (esbuild), smoke.ts (Bot-Test)
release/  fertiger Build: server.mjs und public/ (Client mit Grafiken)
```

Netzwerk in Kurzform: Der Client schickt 30 mal pro Sekunde seine Eingaben und sagt seine eigene Bewegung mit derselben
Funktion (`shared/sim.ts`) voraus. Der Server rechnet nach, schickt 20 Snapshots pro Sekunde und bestätigt jede Eingabe;
weicht der Client ab, wird er korrigiert. Andere Spieler werden mit 100 ms Puffer weich interpoliert.

## Grafik und Lizenzen

Die Modelle stammen von **Kay Lousberg (KayKit)**, Lizenz CC0 (frei nutzbar, Nennung freiwillig):

- [KayKit City Builder Bits 1.0](https://kaylousberg.itch.io/city-builder-bits): Gebäude, Autos, Laternen, Ampeln, Bänke, Hydranten, Container, Wassertürme, Büsche
- [KayKit Adventurers 1.0](https://kaylousberg.itch.io/kaykit-adventurers): Figuren „Rogue“ und „Rogue Hooded“ mit Animationen

Die Dateien liegen unter `client/public/assets/` (mit den Original-Lizenzdateien). Das Flugzeug ist selbst gebaut.

Eigene Effekte (kein Fremdmaterial): Himmel-Shader mit Wolken, weiche Schatten, Leuchtspuren, Mündungsfeuer, Funken,
Explosionen mit Rauch und Staub hinter schnellen Autos. Die Figuren zielen mit dem Oberkörper, während die Beine
weiterlaufen. Ist das Tablet zu langsam, schaltet das Spiel nach wenigen Sekunden selbst Schatten und Auflösung herunter.
Mit `?q=low` oder `?q=high` an der Adresse legst du die Stufe fest.
Fehlen die Modelle oder lassen sie sich nicht laden, zeigt das Spiel einfache Klötze statt der Stadt.

Das Projekt selbst steht unter der GNU General Public License v3 (siehe `LICENSE`). Eingesetzte Bibliotheken:
Three.js (MIT), ws (MIT), esbuild (MIT).

## Stand und Grenzen

Spielbarer Prototyp. Noch nicht umgesetzt: Beifahrer-Sitze, Lag-Kompensation beim Schießen, Sounds, Konten und
Speicherstand. Beim Gestalten bitte keine fremden Marken oder Logos verwenden.
