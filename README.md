# Stadtkampf

Kleiner **Deathmatch-Shooter** für den **Handy-Browser**, gedacht für dich und 2 bis 10 Freunde. Jeder gegen jeden in einer
kompakten Stadt-Arena (260 × 260 m). Alles ist für **Touch** gebaut (Joystick links, Kamera-Wischen und Buttons rechts),
am Rechner geht es auch mit Tastatur. (Das Repository heißt noch nach dem früheren Open-World-Prototyp.)

- Kostet nichts: Browser-Spiel, Open-Source-Werkzeuge, CC0-Grafiken, keine Store-Gebühren.
- Ein einziger Node.js-Prozess ist Webserver und Spielserver. Freunde bekommen nur einen Link.
- Der Server entscheidet über Bewegung, Treffer, Schaden, Aufsammeln und Runden (Clients können nicht schummeln).
- **Auf dem Tablet oder Handy (Termux) braucht es nur Node.js:** das fertige Spiel liegt im Ordner `release/`.

## Spielkonzept

**Eine Runde dauert 5 Minuten oder bis jemand 20 Kills hat.** Danach zeigt eine Rangliste 10 Sekunden lang das Ergebnis,
dann beginnt sofort die nächste Runde mit zurückgesetzten Punkten. Wer zu spät dazukommt, steigt einfach ein.

- **Alle starten gleich:** mit der Pistole (Magazin 12, unendlich Reserve) und 100 Leben. Wer will, bleibt dabei.
- **Bessere Waffen musst du dir holen.** Sie liegen als leuchtende Gegenstände fest auf der Karte und kommen nach
  einigen Sekunden wieder. Das Sturmgewehr liegt an den vier Kreuzungen rund um die Mitte, der RPG-7 mitten auf dem
  Platz (und an zwei Ecken). Wer in die Mitte läuft, bekommt die stärkste Waffe, aber auch alle Gegner zu sehen.
  Gewehr und RPG haben begrenzte Reserve (90 beziehungsweise 3 Raketen); stirbst du, sind sie weg.
- **Medikits** (+50 Leben) liegen auf den Straßen. Ein Kill gibt zusätzlich +15 Leben.
- **Kopfschüsse** machen doppelten Schaden. Das Fadenkreuz zeigt Treffer (weiß), Kopfschüsse (gelb) und Kills (rot).
- **Fair spawnen:** Nach dem Tod gibt es nach 3 Sekunden einen neuen Spawn möglichst weit weg von Gegnern und nie direkt
  auf einer Waffe. 2,5 Sekunden Schutz (die Figur blinkt), der endet, sobald du schießt.
- **Nachladen** gehört dazu: jedes Magazin ist begrenzt, bei leerem Magazin lädt die Figur automatisch nach.
- **Cover zählt:** Gebäude blockieren Kugeln und RPG-Raketen. Die RPG-Explosion (Radius 6,5 m) trifft auch durch
  Ecken, und die eigene Rakete tut nur halb so viel Schaden.
- Die Minimap zeigt Gegner (rot), Gegenstände (grün, gelb, orange) und den Arena-Rand. Am roten Rand ist Schluss.

| Waffe | Schaden | Magazin | Nachladen | Reserve |
|---|---|---|---|---|
| Pistole | 22 (Kopf 44) | 12 | 1,4 s | unendlich |
| Sturmgewehr | 12 (Kopf 24), 10 Schuss/s | 30 | 2,0 s | 90 |
| RPG-7 | bis 110 im Umkreis | 1 | 2,6 s | 3 |

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
| `KILL_LIMIT` | `20` | Kills, bei denen die Runde endet |
| `ROUND_TIME` | `300` | Rundendauer in Sekunden |

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
| Laufen | Joystick links (erscheint, wo der Daumen aufsetzt) | WASD oder Pfeile |
| Umsehen | Wischen rechts, auch über dem Feuer-Button | Maus ziehen |
| Schießen | Feuer-Button halten | Leertaste |
| Waffe wechseln | „Waffe“ oder Slot im Waffen-HUD antippen | Q, oder 1/2/3 |
| Nachladen | „Nachladen“-Button | T |

Das Waffen-HUD unten links zeigt Waffe, Magazin, Reserve und einen Nachladebalken. Oben in der Mitte stehen Rundenzeit
und Kill-Ziel, links oben die Rangliste.

## Aufbau

```
client/   Browser-Client (Three.js): Welt, Touch-Steuerung, HUD, Modelle laden
server/   Spielserver (Node.js, ws): Runden, Treffer, Aufsammeln, Spawns, liefert den Client aus
shared/   Karte und Bewegungslogik, von Server und Client gemeinsam genutzt
scripts/  build.mjs (esbuild), smoke.ts (Bot-Test)
release/  fertiger Build: server.mjs und public/ (Client mit Grafiken)
```

Netzwerk in Kurzform: Der Client schickt 30 mal pro Sekunde seine Eingaben und sagt seine eigene Bewegung mit derselben
Funktion (`shared/sim.ts`) voraus. Der Server rechnet nach, schickt 20 Snapshots pro Sekunde und bestätigt jede Eingabe;
weicht der Client ab, wird er korrigiert. Andere Spieler werden mit 100 ms Puffer weich interpoliert.
Der Bot-Test (`npm run smoke`) läuft gegen einen Server mit `SPAWN_NEAR=1` (nahe Spawns); für den Rundenende-Test
zusätzlich `KILL_LIMIT=1` und `EXPECT_ROUND_END=1`.

## Grafik und Lizenzen

Alle Modelle sind frei nutzbar (Lizenzdateien liegen in `client/public/assets/`):

- **Kay Lousberg (KayKit)**, CC0: [City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) (Gebäude, Laternen, Ampeln, Bänke, Hydranten, Container, Wassertürme, Büsche),
  [Adventurers](https://kaylousberg.itch.io/kaykit-adventurers) (Figuren mit Animationen),
  [Prototype Bits](https://github.com/KayKit-Game-Assets/KayKit-Prototype-Bits-1.0) (Fässer, Paletten, Kisten)
- Selbst gebaut: Waffenmodelle (Pistole, Sturmgewehr, RPG-7), Kiefern, Himmel, Partikel und Decals

Maßstäbe sind echte Meter: Figur 1,8 m, Stockwerke rund 3,3 m, Straßen 24 m breit.

Effekte: Himmel-Shader mit Wolken, weiche Schatten, Leuchtspuren, Mündungsfeuer, Funken, **Einschusslöcher** an
Wänden und am Boden (verblassen nach etwa 25 Sekunden), Brandflecken und Feuerball mit Trümmern und Kamerawackeln bei
RPG-Explosionen, RPG-Rückstoß-Feuerstrahl. Die Figuren zielen mit dem Oberkörper, während die Beine weiterlaufen.
Ist das Tablet zu langsam, schaltet das Spiel nach wenigen Sekunden selbst Schatten und Auflösung herunter.
Mit `?q=low` oder `?q=high` an der Adresse legst du die Stufe fest.

Das Projekt selbst steht unter der GNU General Public License v3 (siehe `LICENSE`). Eingesetzte Bibliotheken:
Three.js (MIT), ws (MIT), esbuild (MIT).
