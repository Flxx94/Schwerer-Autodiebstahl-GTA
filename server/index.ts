// Spiel-Server (Stadtkampf): autoritativ. Der Client schickt nur Eingaben, der Server entscheidet ueber
// Bewegung, Treffer, Schaden, Aufsammeln und Runden. Ein Prozess reicht fuer 2 bis 10 Spieler.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Box, PICKUPS, WORLD, buildMap, distToBoxes } from '../shared/map';
import { Body, Input, newBody, step, clamp } from '../shared/sim';

const PORT = Number(process.env.PORT ?? 8080);
const ROOM_CODE = process.env.ROOM_CODE ?? 'freunde'; // leer = kein Raumcode
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 10);
const TICK_HZ = 20;
const MAP_SEED = 1337;

// Rundenregeln: Deathmatch, jeder gegen jeden
const KILL_LIMIT = Number(process.env.KILL_LIMIT ?? 20);
const ROUND_TIME = Number(process.env.ROUND_TIME ?? 300); // Sekunden
const END_TIME = 10; // so lange steht die Rangliste
const RESPAWN_TIME = 3;
const PROTECT_TIME = 2.5; // Schutz nach dem Spawn
const SPAWN_NEAR = process.env.SPAWN_NEAR === '1'; // nur fuer Tests: nahe statt ferne Spawns
const HEADSHOT = 2; // Schadensfaktor Kopfschuss

const boxes: Box[] = buildMap(MAP_SEED);

// Waffen. Die Pistole hat unendlich Reserve (res = -1). Gewehr und RPG findet man als Gegenstand;
// dann gibt es Magazin plus begrenzte Reserve.
interface Weapon {
  name: string;
  dmg: number;
  cd: number; // Sekunden zwischen zwei Schuessen
  range: number;
  mag: number; // Magazingroesse
  reload: number; // Nachladezeit in Sekunden
  pickupRes: number; // Reserve nach dem Aufsammeln (-1 = unendlich)
}
const WEAPONS: Weapon[] = [
  { name: 'Pistole', dmg: 22, cd: 0.3, range: 120, mag: 12, reload: 1.4, pickupRes: -1 },
  { name: 'Sturmgewehr', dmg: 12, cd: 0.1, range: 150, mag: 30, reload: 2.0, pickupRes: 90 },
  { name: 'RPG-7', dmg: 0, cd: 1.0, range: 300, mag: 1, reload: 2.6, pickupRes: 3 },
];
const RPG_DMG = 110;
const RPG_RADIUS = 6.5;

interface Player {
  id: number;
  name: string;
  hue: number;
  ws: WebSocket;
  body: Body;
  hp: number;
  weapon: number; // gewaehlte Waffe
  own: boolean[]; // Waffe im Besitz
  ammo: number[]; // Schuss im Magazin je Waffe
  res: number[]; // Reserve je Waffe, -1 = unendlich
  reload: { idx: number; until: number; dur: number } | null;
  ack: number;
  tokens: number;
  tokensAt: number;
  lastFire: number;
  deadUntil: number;
  protUntil: number;
  kills: number;
  deaths: number;
  streak: number;
}
interface Proj {
  id: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  owner: number;
  life: number;
}

const players = new Map<number, Player>();
let projs: Proj[] = [];
let events: any[] = [];
let nextId = 1;
const now = () => Date.now() / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Runde ----------
let roundState: 'play' | 'end' = 'play';
let roundEnds = 0;
let winner = '';
const pickupAt: number[] = PICKUPS.map(() => 0); // Zeitpunkt, ab dem der Gegenstand wieder da ist

function startRound() {
  roundState = 'play';
  roundEnds = now() + ROUND_TIME;
  winner = '';
  projs = [];
  pickupAt.fill(0);
  for (const p of players.values()) {
    p.kills = 0;
    p.deaths = 0;
    p.streak = 0;
    respawn(p);
  }
}

function endRound() {
  roundState = 'end';
  roundEnds = now() + END_TIME;
  const list = [...players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  winner = list.length ? list[0].name : '';
  events.push({ k: 'win', n: winner, kills: list[0]?.kills ?? 0 });
}

// ---------- Hilfsfunktionen ----------
function newPlayer(id: number, name: string, ws: WebSocket): Player {
  const p: Player = {
    id,
    name,
    hue: Math.floor(Math.random() * 360),
    ws,
    body: newBody(0, 0, 0),
    hp: 100,
    weapon: 0,
    own: [true, false, false],
    ammo: WEAPONS.map((w) => w.mag),
    res: [-1, 0, 0],
    reload: null,
    ack: 0,
    tokens: 10,
    tokensAt: now(),
    lastFire: 0,
    deadUntil: 0,
    protUntil: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
  };
  respawn(p);
  return p;
}

// Spawnpunkt: aus mehreren Zufallspunkten der mit dem groessten Abstand zu allen lebenden Gegnern
function spawnPoint(self: Player | null): { x: number; z: number } {
  let best = { x: 0, z: 0 };
  let bestD = -Infinity;
  for (let i = 0; i < 14; i++) {
    const x = (Math.random() - 0.5) * (WORLD * 2 - 20);
    const z = (Math.random() - 0.5) * (WORLD * 2 - 20);
    if (distToBoxes(boxes, x, z) < 2.5) continue;
    // nicht direkt auf einer Waffe spawnen (das waere ein geschenkter Vorteil)
    if (PICKUPS.some((k) => k.kind > 0 && Math.hypot(k.x - x, k.z - z) < 6)) continue;
    let d = Infinity;
    for (const q of players.values()) if (q !== self && q.hp > 0) d = Math.min(d, Math.hypot(q.body.x - x, q.body.z - z));
    if (d === Infinity) d = 100;
    if (SPAWN_NEAR) d = -Math.abs(d - 30);
    if (d > bestD) {
      bestD = d;
      best = { x, z };
    }
  }
  return best;
}

function respawn(p: Player) {
  const s = spawnPoint(p);
  p.body = newBody(s.x, s.z, p.body.yaw);
  p.hp = 100;
  p.protUntil = now() + PROTECT_TIME;
  p.weapon = 0;
  p.own = [true, false, false];
  p.ammo = WEAPONS.map((w) => w.mag);
  p.res = [-1, 0, 0];
  p.reload = null;
}

function eye(p: Player): [number, number, number] {
  return [p.body.x, 1.5, p.body.z];
}

function dirFrom(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

function rayBox(o: number[], d: number[], b: Box): number {
  const mins = [b.x - b.hw, 0, b.z - b.hd];
  const maxs = [b.x + b.hw, b.h, b.z + b.hd];
  let tmin = 0;
  let tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < mins[k] || o[k] > maxs[k]) return Infinity;
    } else {
      let t1 = (mins[k] - o[k]) / d[k];
      let t2 = (maxs[k] - o[k]) / d[k];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

function raySphere(o: number[], d: number[], c: number[], r: number): number {
  const lx = c[0] - o[0];
  const ly = c[1] - o[1];
  const lz = c[2] - o[2];
  const t = lx * d[0] + ly * d[1] + lz * d[2];
  if (t < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - t * t;
  if (d2 > r * r) return Infinity;
  return Math.max(0, t - Math.sqrt(r * r - d2));
}

function damagePlayer(p: Player, dmg: number, by: number | null, w: number, hs = false) {
  const t = now();
  if (p.hp <= 0 || p.protUntil > t || roundState !== 'play') return;
  const killer = by !== null ? players.get(by) : undefined;
  p.hp -= dmg;
  events.push({ k: 'hit', by: by ?? 0, to: p.id, hs: hs ? 1 : 0, dead: p.hp <= 0 ? 1 : 0 });
  if (p.hp > 0) return;
  p.hp = 0;
  p.deaths++;
  p.streak = 0;
  p.deadUntil = t + RESPAWN_TIME;
  p.reload = null;
  let streak = 0;
  if (killer && killer !== p) {
    killer.kills++;
    killer.streak++;
    streak = killer.streak;
    // Belohnung: kleine Heilung fuer den Sieger
    killer.hp = Math.min(100, killer.hp + 15);
  }
  events.push({ k: 'kill', a: killer && killer !== p ? killer.name : '', b: p.name, w, hs: hs ? 1 : 0, s: streak });
  if (killer && killer !== p && killer.kills >= KILL_LIMIT) endRound();
}

function explode(x: number, y: number, z: number, radius: number, dmg: number, by: number | null) {
  events.push({ k: 'boom', x: r2(x), y: r2(y), z: r2(z), r: radius });
  for (const p of players.values()) {
    if (p.hp <= 0) continue;
    const d = Math.hypot(p.body.x - x, p.body.y + 1 - y, p.body.z - z);
    if (d >= radius) continue;
    let k = 1 - d / radius;
    if (p.id === by) k *= 0.5; // eigene Rakete tut weniger weh
    damagePlayer(p, Math.max(10, dmg * k), by, 2);
  }
}

// ---------- Munition und Nachladen ----------
function startReload(p: Player) {
  if (p.hp <= 0 || p.reload) return;
  const w = WEAPONS[p.weapon];
  if (p.ammo[p.weapon] >= w.mag || p.res[p.weapon] === 0) return;
  p.reload = { idx: p.weapon, until: now() + w.reload, dur: w.reload };
  events.push({ k: 'rl', by: p.id, d: w.reload, w: p.weapon });
}

function finishReloads(t: number) {
  for (const p of players.values()) {
    const r = p.reload;
    if (!r) continue;
    if (p.weapon !== r.idx) {
      p.reload = null; // Waffenwechsel bricht das Nachladen ab
      continue;
    }
    if (t >= r.until) {
      const w = WEAPONS[r.idx];
      const need = w.mag - p.ammo[r.idx];
      const take = p.res[r.idx] < 0 ? need : Math.min(need, p.res[r.idx]);
      p.ammo[r.idx] += take;
      if (p.res[r.idx] >= 0) p.res[r.idx] -= take;
      p.reload = null;
    }
  }
}

function fire(p: Player, aimYaw: number, aimPitch: number) {
  if (p.hp <= 0 || roundState !== 'play') return;
  const w = WEAPONS[p.weapon];
  const t = now();
  if (p.reload) return;
  if (t - p.lastFire < w.cd * 0.9) return;
  if (p.ammo[p.weapon] <= 0) return startReload(p);
  p.lastFire = t;
  p.protUntil = Math.min(p.protUntil, t); // wer schiesst, ist nicht mehr geschuetzt
  p.ammo[p.weapon]--;
  const d = dirFrom(aimYaw, clamp(aimPitch, -1.2, 1.2));
  const o = eye(p);
  const afterShot = () => {
    if (p.ammo[p.weapon] <= 0) startReload(p);
  };
  if (p.weapon === 2) {
    // RPG-Granate
    projs.push({ id: nextId++, x: o[0] + d[0] * 1.5, y: o[1] + d[1] * 1.5, z: o[2] + d[2] * 1.5, dx: d[0] * 45, dy: d[1] * 45, dz: d[2] * 45, owner: p.id, life: 4 });
    events.push({ k: 'shot', by: p.id, a: o.map(r2), b: o.map((v, i) => r2(v + d[i] * 3)), w: 2 });
    return afterShot();
  }
  let wall = w.range;
  if (d[1] < -0.001) wall = Math.min(wall, o[1] / -d[1]); // Boden
  for (const b of boxes) {
    const tt = rayBox(o, d, b);
    if (tt < wall) wall = tt;
  }
  let best = wall;
  let hitP: Player | null = null;
  let hs = false;
  for (const q of players.values()) {
    if (q === p || q.hp <= 0) continue;
    const dist = Math.hypot(q.body.x - o[0], 1 - o[1], q.body.z - o[2]);
    // Kopf (kleine Kugel) zuerst, dann der Rumpf (grosse Kugel; etwas Zielhilfe fuer Touch)
    const th = raySphere(o, d, [q.body.x, 1.62, q.body.z], 0.3 + dist * 0.02);
    if (th < best) {
      best = th;
      hitP = q;
      hs = true;
      continue;
    }
    const tt = raySphere(o, d, [q.body.x, 0.95, q.body.z], 0.75 + dist * 0.04);
    if (tt < best) {
      best = tt;
      hitP = q;
      hs = false;
    }
  }
  if (hitP) damagePlayer(hitP, w.dmg * (hs ? HEADSHOT : 1), p.id, p.weapon, hs);
  events.push({
    k: 'shot',
    by: p.id,
    a: o.map(r2),
    b: o.map((v, i) => r2(v + d[i] * Math.min(best, 150))),
    w: p.weapon,
    hit: hitP ? 1 : 0,
    wl: !hitP && wall < w.range ? 1 : 0, // Treffer an Gebaeude oder Boden: Einschussloch
  });
  afterShot();
}

// ---------- Eingaben ----------
function handleInput(p: Player, m: any) {
  const t = now();
  p.tokens = Math.min(10, p.tokens + (t - p.tokensAt) * 35);
  p.tokensAt = t;
  const seq = Number(m.seq) | 0;
  if (p.hp <= 0 || p.tokens < 1) {
    p.ack = seq;
    return;
  }
  p.tokens -= 1;
  const inp: Input = { seq, mx: Number(m.mx) || 0, mz: Number(m.mz) || 0, yaw: Number(m.yaw) || 0 };
  step(p.body, inp, boxes);
  p.ack = seq;
}

function onMessage(p: Player, m: any) {
  switch (m.t) {
    case 'in':
      return handleInput(p, m);
    case 'f':
      return fire(p, Number(m.yaw) || 0, Number(m.pitch) || 0);
    case 'weapon': {
      const i = clamp(Math.floor(Number(m.i) || 0), 0, WEAPONS.length - 1);
      if (p.own[i] && i !== p.weapon) {
        p.weapon = i;
        p.reload = null;
      }
      return;
    }
    case 'next': {
      // naechste Waffe im Besitz
      for (let k = 1; k <= WEAPONS.length; k++) {
        const i = (p.weapon + k) % WEAPONS.length;
        if (p.own[i]) {
          if (i !== p.weapon) {
            p.weapon = i;
            p.reload = null;
          }
          return;
        }
      }
      return;
    }
    case 'reload':
      return startReload(p);
    case 'ping':
      return send(p.ws, { t: 'pong', c: m.c });
  }
}

// ---------- Gegenstaende ----------
function collectPickups(t: number) {
  PICKUPS.forEach((pk, i) => {
    if (pickupAt[i] > t) return;
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      if (Math.hypot(p.body.x - pk.x, p.body.z - pk.z) > 1.7) continue;
      if (pk.kind === 0) {
        if (p.hp >= 100) continue;
        p.hp = Math.min(100, p.hp + 50);
      } else {
        const w = WEAPONS[pk.kind];
        if (!p.own[pk.kind]) {
          p.own[pk.kind] = true;
          p.ammo[pk.kind] = w.mag;
          p.res[pk.kind] = w.pickupRes;
          p.weapon = pk.kind; // frische Waffe sofort in die Hand
          p.reload = null;
        } else {
          p.res[pk.kind] = w.pickupRes; // Reserve auffuellen
        }
      }
      pickupAt[i] = t + pk.respawn;
      events.push({ k: 'pick', by: p.id, i, kind: pk.kind });
      break;
    }
  });
}

// Waffen-HUD des Spielers: Name, Magazin, Reserve, Nachladefortschritt
function weaponInfo(p: Player) {
  const w = WEAPONS[p.weapon];
  const r = p.reload;
  return {
    wi: p.weapon,
    wn: w.name,
    am: p.ammo[p.weapon],
    mg: w.mag,
    rs: p.res[p.weapon],
    rl: r ? r2(clamp(1 - (r.until - now()) / r.dur, 0, 1)) : 0,
    ow: p.own.map((o) => (o ? 1 : 0)),
  };
}

function tick() {
  const t = now();
  const dt = 1 / TICK_HZ;
  // Raketen
  const alive: Proj[] = [];
  for (const pr of projs) {
    let boom = false;
    for (let s = 0; s < 3 && !boom; s++) {
      pr.x += (pr.dx * dt) / 3;
      pr.y += (pr.dy * dt) / 3;
      pr.z += (pr.dz * dt) / 3;
      if (pr.y < 0) boom = true;
      else {
        for (const b of boxes) {
          if (pr.y < b.h && Math.abs(pr.x - b.x) < b.hw && Math.abs(pr.z - b.z) < b.hd) {
            boom = true;
            break;
          }
        }
      }
      if (!boom) {
        for (const q of players.values()) {
          if (q.id === pr.owner || q.hp <= 0) continue;
          if (Math.hypot(q.body.x - pr.x, q.body.y + 1 - pr.y, q.body.z - pr.z) < 1.4) boom = true;
        }
      }
    }
    pr.life -= dt;
    if (boom) explode(pr.x, Math.max(0, pr.y), pr.z, RPG_RADIUS, RPG_DMG, pr.owner);
    else if (pr.life > 0) alive.push(pr);
  }
  projs = alive;

  finishReloads(t);
  if (roundState === 'play') {
    collectPickups(t);
    for (const p of players.values()) if (p.hp <= 0 && t >= p.deadUntil) respawn(p);
    if (t >= roundEnds) endRound();
  } else if (t >= roundEnds) {
    startRound();
  }

  const pl = [...players.values()].map((p) => ({
    i: p.id,
    n: p.name,
    h: p.hue,
    x: r2(p.body.x),
    y: 0,
    z: r2(p.body.z),
    yaw: r2(p.body.yaw),
    hp: Math.round(p.hp),
    k: p.kills,
    d: p.deaths,
    w: p.weapon,
    pr: p.protUntil > t ? 1 : 0,
  }));
  const pr = projs.map((q) => {
    const l = Math.hypot(q.dx, q.dy, q.dz) || 1;
    return { i: q.id, k: 0, x: r2(q.x), y: r2(q.y), z: r2(q.z), d: [r2(q.dx / l), r2(q.dy / l), r2(q.dz / l)] };
  });
  const pk = PICKUPS.map((_, i) => (pickupAt[i] > t ? 0 : 1));
  const ev = events;
  events = [];
  const rd = { s: roundState === 'play' ? 0 : 1, t: Math.max(0, Math.ceil(roundEnds - t)), lim: KILL_LIMIT, win: winner };
  for (const p of players.values()) {
    send(p.ws, {
      t: 's',
      ts: Date.now(),
      ack: p.ack,
      you: { x: r2(p.body.x), y: 0, z: r2(p.body.z), yaw: r2(p.body.yaw), speed: r2(p.body.speed) },
      hp: Math.round(p.hp),
      ...weaponInfo(p),
      rd,
      pk,
      pl,
      pr,
      ev,
    });
  }
}

// ---------- HTTP (liefert den gebauten Client aus) und WebSocket ----------
const here = path.dirname(fileURLToPath(import.meta.url));
// Der Client liegt neben der Server-Datei in public/ (siehe scripts/build.mjs)
const DIST = path.resolve(here, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end('ok');
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return void res.end(fs.existsSync(DIST) ? 'Nicht gefunden' : 'Client fehlt: erst "npm run build" ausfuehren');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  let me: Player | null = null;
  ws.on('message', (data) => {
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!me) {
      if (m.t !== 'join') return;
      if (ROOM_CODE && String(m.room ?? '').trim().toLowerCase() !== ROOM_CODE.toLowerCase()) {
        send(ws, { t: 'err', text: 'Falscher Raumcode' });
        return ws.close();
      }
      if (players.size >= MAX_PLAYERS) {
        send(ws, { t: 'err', text: 'Der Server ist voll' });
        return ws.close();
      }
      const name = String(m.name ?? '').replace(/[<>&]/g, '').trim().slice(0, 16) || 'Spieler';
      const id = nextId++;
      me = newPlayer(id, name, ws);
      players.set(id, me);
      send(ws, { t: 'w', id, seed: MAP_SEED, room: ROOM_CODE });
      console.log(`+ ${name} (${players.size} Spieler)`);
      return;
    }
    onMessage(me, m);
  });
  ws.on('close', () => {
    if (!me) return;
    const p = me;
    players.delete(p.id);
    console.log(`- ${p.name} (${players.size} Spieler)`);
  });
});

startRound();
setInterval(tick, 1000 / TICK_HZ);
server.listen(PORT, () => {
  console.log(`Server laeuft auf http://localhost:${PORT} (Raumcode: ${ROOM_CODE || 'keiner'}, max ${MAX_PLAYERS} Spieler)`);
  // Adressen im WLAN anzeigen. Auf manchen Android-Geraeten (Termux) schlaegt das fehl, dann einfach ueberspringen.
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  im WLAN erreichbar: http://${a.address}:${PORT}`);
    }
  } catch {
    console.log('  (WLAN-Adresse nicht ermittelbar: in Termux "ip addr" oder "ifconfig" nutzen)');
  }
});
