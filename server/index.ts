// Spiel-Server: autoritativ. Der Client schickt nur Eingaben, der Server entscheidet ueber
// Bewegung, Spawns, Treffer und Schaden. Ein Prozess reicht fuer 5 bis 10 Spieler.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Box, WORLD, RUNWAY, buildMap, distToBoxes } from '../shared/map';
import { Body, Input, CAR, PLANE, newBody, step, clamp, planeAxes } from '../shared/sim';

const PORT = Number(process.env.PORT ?? 8080);
const ROOM_CODE = process.env.ROOM_CODE ?? 'freunde'; // leer = kein Raumcode
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 10);
const TICK_HZ = 20;
const MAP_SEED = 1337;

const boxes: Box[] = buildMap(MAP_SEED);

// Waffen: unendlich Munition, aber nur ein Magazin (mag) am Stueck, danach Nachladen (reload Sekunden)
interface Weapon {
  name: string;
  dmg: number;
  cd: number; // Sekunden zwischen zwei Schuessen
  range: number;
  mag: number; // Magazingroesse
  reload: number; // Nachladezeit in Sekunden
}
const WEAPONS: Weapon[] = [
  { name: 'Pistole', dmg: 25, cd: 0.35, range: 120, mag: 12, reload: 1.4 },
  { name: 'Sturmgewehr', dmg: 11, cd: 0.1, range: 150, mag: 30, reload: 2.0 },
  { name: 'RPG-7', dmg: 0, cd: 1.0, range: 300, mag: 1, reload: 2.6 },
];
// Waffen im Flugzeug: Bordkanone, Raketen, Bomben
const PLANE_WEAPONS: Weapon[] = [
  { name: 'Bordkanone', dmg: 8, cd: 0.08, range: 220, mag: 100, reload: 2.8 },
  { name: 'Raketen', dmg: 0, cd: 0.45, range: 300, mag: 4, reload: 3.5 },
  { name: 'Bomben', dmg: 0, cd: 0.7, range: 0, mag: 3, reload: 4.5 },
];

interface Player {
  id: number;
  name: string;
  hue: number;
  ws: WebSocket;
  body: Body; // Koerper zu Fuss
  hp: number;
  weapon: number; // gewaehlte Waffe zu Fuss
  pweapon: number; // gewaehlte Waffe im Flugzeug
  ammo: number[]; // Schuss im Magazin je Waffe zu Fuss
  pammo: number[]; // ... je Waffe im Flugzeug
  reload: { plane: boolean; idx: number; until: number; dur: number } | null;
  veh: number | null;
  ack: number;
  tokens: number;
  tokensAt: number;
  lastFire: number;
  lastSpawn: number;
  deadUntil: number;
  protUntil: number;
  kills: number;
  deaths: number;
}
interface Vehicle {
  id: number;
  kind: 1 | 2;
  body: Body;
  owner: number;
  driver: number | null;
  hp: number;
  emptySince: number;
  burnUntil: number; // > 0: Fahrzeug brennt und explodiert zu diesem Zeitpunkt
  burnBy: number | null;
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
  k: 0 | 1 | 2; // 0 = RPG-Granate, 1 = Flugzeugrakete, 2 = Bombe
  g: number; // Schwerkraft (Bombe)
  r: number; // Explosionsradius
  dmg: number;
  ignoreVeh: number; // eigenes Fahrzeug in den ersten Sekunden ignorieren
  age: number;
}

const players = new Map<number, Player>();
const vehicles = new Map<number, Vehicle>();
let projs: Proj[] = [];
let events: any[] = [];
let nextId = 1;
const now = () => Date.now() / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
const say = (p: Player, text: string) => send(p.ws, { t: 'msg', text });

function spawnPoint(): { x: number; z: number } {
  for (let i = 0; i < 20; i++) {
    const x = (Math.random() - 0.5) * 80;
    const z = (Math.random() - 0.5) * 80;
    if (distToBoxes(boxes, x, z) > 2) return { x, z };
  }
  return { x: 0, z: 0 };
}

function controlBody(p: Player): Body {
  if (p.veh !== null) {
    const v = vehicles.get(p.veh);
    if (v) return v.body;
  }
  return p.body;
}

function eye(p: Player): [number, number, number] {
  const b = controlBody(p);
  if (p.veh !== null) return [b.x, b.y + (b.mode === PLANE ? 1.2 : 1.6), b.z];
  return [b.x, b.y + 1.5, b.z];
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

function damagePlayer(p: Player, dmg: number, by: number | null) {
  const t = now();
  if (p.hp <= 0 || p.protUntil > t) return;
  p.hp -= dmg;
  if (p.hp > 0) return;
  p.hp = 0;
  p.deaths++;
  p.deadUntil = t + 4;
  const killer = by !== null ? players.get(by) : undefined;
  if (killer && killer !== p) killer.kills++;
  events.push({ k: 'kill', a: killer && killer !== p ? killer.name : '', b: p.name });
  if (p.veh !== null) {
    const v = vehicles.get(p.veh);
    p.veh = null;
    if (v) {
      v.driver = null;
      v.emptySince = t;
      if (v.kind === PLANE && v.body.y > 2) destroyVehicle(v, by);
    }
  }
}

const BURN_TIME = 3.8; // so lange brennt ein Fahrzeug, bevor es explodiert

// Schaden an einem Fahrzeug: bei 0 Leben faengt es erst Feuer und explodiert kurz danach
function damageVehicle(v: Vehicle, dmg: number, by: number | null) {
  if (v.burnUntil > 0) return;
  v.hp -= dmg;
  if (v.hp <= 0) {
    v.hp = 1;
    v.burnUntil = now() + BURN_TIME;
    v.burnBy = by;
  }
}

function destroyVehicle(v: Vehicle, by: number | null) {
  if (!vehicles.delete(v.id)) return;
  if (v.driver !== null) {
    const d = players.get(v.driver);
    if (d) {
      d.veh = null;
      d.body = newBody(v.body.x, v.body.z, d.body.yaw);
      damagePlayer(d, 200, by);
    }
  }
  explode(v.body.x, v.body.y + 1, v.body.z, 7, 70, by);
}

function explode(x: number, y: number, z: number, radius: number, dmg: number, by: number | null) {
  events.push({ k: 'boom', x: r2(x), y: r2(y), z: r2(z), r: radius });
  for (const p of players.values()) {
    if (p.hp <= 0) continue;
    const b = controlBody(p);
    const d = Math.hypot(b.x - x, b.y + 1 - y, b.z - z);
    if (d < radius) damagePlayer(p, Math.max(10, dmg * (1 - d / radius)), by);
  }
  for (const v of [...vehicles.values()]) {
    const d = Math.hypot(v.body.x - x, v.body.y + 1 - y, v.body.z - z);
    if (d < radius) {
      damageVehicle(v, dmg * 1.5 * (1 - d / radius), by);
    }
  }
}

// ---------- Munition und Nachladen ----------
function ctxWeapons(p: Player): { list: Weapon[]; ammo: number[]; idx: number; plane: boolean } | null {
  const veh = p.veh !== null ? vehicles.get(p.veh) : undefined;
  if (veh) {
    if (veh.kind !== PLANE) return null;
    return { list: PLANE_WEAPONS, ammo: p.pammo, idx: p.pweapon, plane: true };
  }
  return { list: WEAPONS, ammo: p.ammo, idx: p.weapon, plane: false };
}

function startReload(p: Player) {
  const c = ctxWeapons(p);
  if (!c || p.hp <= 0 || p.reload) return;
  const w = c.list[c.idx];
  if (c.ammo[c.idx] >= w.mag) return;
  p.reload = { plane: c.plane, idx: c.idx, until: now() + w.reload, dur: w.reload };
  events.push({ k: 'rl', by: p.id, d: w.reload, w: c.plane ? 3 + c.idx : c.idx });
}

function finishReloads(t: number) {
  for (const p of players.values()) {
    const r = p.reload;
    if (!r) continue;
    // Wechselt man das Fahrzeug oder die Waffe, bricht das Nachladen ab
    const c = ctxWeapons(p);
    if (!c || c.plane !== r.plane || c.idx !== r.idx) {
      p.reload = null;
      continue;
    }
    if (t >= r.until) {
      c.ammo[r.idx] = c.list[r.idx].mag;
      p.reload = null;
    }
  }
}

function refill(p: Player) {
  p.ammo = WEAPONS.map((w) => w.mag);
  p.pammo = PLANE_WEAPONS.map((w) => w.mag);
  p.reload = null;
}

function spawnProj(p: Player, o: number[], v: number[], k: 0 | 1 | 2, ownVeh: number) {
  projs.push({
    id: nextId++,
    x: o[0],
    y: o[1],
    z: o[2],
    dx: v[0],
    dy: v[1],
    dz: v[2],
    owner: p.id,
    life: k === 2 ? 12 : 4,
    k,
    g: k === 2 ? 22 : 0,
    r: k === 2 ? 12 : 7,
    dmg: k === 2 ? 150 : 80,
    ignoreVeh: ownVeh,
    age: 0,
  });
}

function fire(p: Player, aimYaw: number, aimPitch: number) {
  if (p.hp <= 0) return;
  const c = ctxWeapons(p);
  if (!c) return; // aus dem Auto wird nicht geschossen
  const w = c.list[c.idx];
  const veh = c.plane && p.veh !== null ? vehicles.get(p.veh) : undefined;
  const t = now();
  if (p.reload) return;
  if (t - p.lastFire < w.cd * 0.9) return;
  if (c.ammo[c.idx] <= 0) return startReload(p);
  p.lastFire = t;
  c.ammo[c.idx]--;
  // Richtung: zu Fuss nach Blick, im Flugzeug entlang der Nase
  let d: number[];
  let o = eye(p);
  let ax = { f: [0, 0, 0], u: [0, 1, 0], r: [1, 0, 0] } as { f: number[]; u: number[]; r: number[] };
  if (veh) {
    const a = planeAxes(veh.body);
    ax = { f: a.f, u: a.u, r: a.r };
    d = a.f;
  } else {
    d = dirFrom(aimYaw, clamp(aimPitch, -1.2, 1.2));
  }
  const afterShot = () => {
    if (c.ammo[c.idx] <= 0) startReload(p);
  };
  if (c.plane && c.idx === 1) {
    // Rakete: abwechselnd links und rechts unter dem Fluegel
    const side = c.ammo[1] % 2 === 0 ? -1 : 1;
    const so = [o[0] + ax.f[0] * 3 + ax.r[0] * 1.7 * side - ax.u[0] * 0.5, o[1] + ax.f[1] * 3 + ax.r[1] * 1.7 * side - ax.u[1] * 0.5, o[2] + ax.f[2] * 3 + ax.r[2] * 1.7 * side - ax.u[2] * 0.5];
    const sp = (veh ? veh.body.speed : 0) + 55;
    spawnProj(p, so, [d[0] * sp, d[1] * sp, d[2] * sp], 1, veh ? veh.id : 0);
    events.push({ k: 'shot', by: p.id, a: so.map(r2), b: so.map((v, i) => r2(v + d[i] * 3)), w: 4 });
    return afterShot();
  }
  if (c.plane && c.idx === 2) {
    // Bombe: faellt aus dem Rumpf, erbt die Fluggeschwindigkeit
    const bo = [o[0] - ax.u[0] * 1.6, o[1] - ax.u[1] * 1.6 - 0.4, o[2] - ax.u[2] * 1.6];
    const sp = (veh ? veh.body.speed : 0) * 0.95;
    spawnProj(p, bo, [d[0] * sp, d[1] * sp - 2, d[2] * sp], 2, veh ? veh.id : 0);
    events.push({ k: 'drop', by: p.id });
    return afterShot();
  }
  if (!c.plane && c.idx === 2) {
    // RPG-Granate
    spawnProj(p, [o[0] + d[0] * 1.5, o[1] + d[1] * 1.5, o[2] + d[2] * 1.5], [d[0] * 45, d[1] * 45, d[2] * 45], 0, 0);
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
  let hitV: Vehicle | null = null;
  for (const q of players.values()) {
    if (q === p || q.hp <= 0 || q.veh !== null) continue;
    const cc = [q.body.x, q.body.y + 1, q.body.z];
    const dist = Math.hypot(cc[0] - o[0], cc[1] - o[1], cc[2] - o[2]);
    const tt = raySphere(o, d, cc, 0.9 + dist * 0.05); // etwas Zielhilfe fuer Touch
    if (tt < best) {
      best = tt;
      hitP = q;
      hitV = null;
    }
  }
  for (const v of vehicles.values()) {
    if (veh && v === veh) continue;
    const cc = [v.body.x, v.body.y + 1.2, v.body.z];
    const dist = Math.hypot(cc[0] - o[0], cc[1] - o[1], cc[2] - o[2]);
    const tt = raySphere(o, d, cc, (v.kind === PLANE ? 3.4 : 2.6) + dist * 0.03);
    if (tt < best) {
      best = tt;
      hitV = v;
      hitP = null;
    }
  }
  if (hitP) damagePlayer(hitP, w.dmg, p.id);
  else if (hitV) {
    damageVehicle(hitV, w.dmg * 2, p.id);
  }
  events.push({
    k: 'shot',
    by: p.id,
    a: o.map(r2),
    b: o.map((v, i) => r2(v + d[i] * Math.min(best, 150))),
    w: c.plane ? 3 : c.idx,
    hit: hitP ? 1 : hitV ? 2 : 0,
    wl: !hitP && !hitV && wall < w.range ? 1 : 0, // Treffer an Gebaeude oder Boden: Einschussloch
  });
  afterShot();
}

function enter(p: Player) {
  if (p.veh !== null || p.hp <= 0) return;
  let best: Vehicle | null = null;
  let bd = Infinity;
  for (const v of vehicles.values()) {
    if (v.driver !== null || v.burnUntil > 0) continue;
    const d = Math.hypot(v.body.x - p.body.x, v.body.z - p.body.z);
    const reach = v.kind === PLANE ? 11 : 8;
    if (d < reach && d < bd) {
      bd = d;
      best = v;
    }
  }
  if (!best) return say(p, 'Kein Fahrzeug in Reichweite');
  best.driver = p.id;
  p.veh = best.id;
}

function leave(p: Player) {
  if (p.veh === null) return;
  const v = vehicles.get(p.veh);
  if (!v) {
    p.veh = null;
    return;
  }
  if (v.body.y > 2 || Math.abs(v.body.speed) > 14) return say(p, 'Hier kannst du nicht aussteigen');
  const b = newBody(v.body.x + Math.cos(v.body.yaw) * 3, v.body.z - Math.sin(v.body.yaw) * 3, v.body.yaw);
  for (let i = 0; i < 4 && distToBoxes(boxes, b.x, b.z) < 0.6; i++) {
    b.x -= Math.cos(v.body.yaw) * 2 * (i === 0 ? 2 : 1);
    b.z += Math.sin(v.body.yaw) * 2 * (i === 0 ? 2 : 1);
  }
  p.body = b;
  v.driver = null;
  v.emptySince = now();
  p.veh = null;
}

// Freie Strecke ab (x,z) in Richtung (dx,dz), gemessen mit drei parallelen Strahlen (Flugzeugbreite)
function freeRun(x: number, z: number, dx: number, dz: number): number {
  let best = 200;
  for (const off of [-5, 0, 5]) {
    const o = [x - dz * off, 5, z + dx * off];
    for (const b of boxes) {
      const t = rayBox(o, [dx, 0, dz], b);
      if (t < best) best = t;
    }
  }
  return best;
}

// Das Flugzeug steht vor dem Spieler und zeigt in die Richtung mit der laengsten freien Strecke
function planeSpot(p: Player): { x: number; z: number; yaw: number } | null {
  let best: { x: number; z: number; yaw: number } | null = null;
  let bestRun = 60; // weniger freie Strecke reicht nicht zum Abheben
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const dx = -Math.sin(a);
    const dz = -Math.cos(a);
    for (const dist of [9, 12, 16]) {
      const x = p.body.x + dx * dist;
      const z = p.body.z + dz * dist;
      if (Math.abs(x) > WORLD - 10 || Math.abs(z) > WORLD - 10) continue;
      if (distToBoxes(boxes, x, z) <= 10) continue;
      const run = freeRun(x, z, dx, dz);
      if (run > bestRun) {
        bestRun = run;
        best = { x, z, yaw: a };
      }
      break;
    }
  }
  return best;
}

function spawnVehicle(p: Player, kind: 1 | 2) {
  const t = now();
  if (p.hp <= 0 || p.veh !== null) return say(p, 'Erst aussteigen');
  if (t - p.lastSpawn < 3) return say(p, 'Kurz warten, bevor du wieder spawnst');
  for (const v of [...vehicles.values()]) {
    if (v.owner === p.id && v.kind === kind) {
      if (v.driver !== null) return say(p, 'Dein Fahrzeug wird gerade gefahren');
      vehicles.delete(v.id);
    }
  }
  const clear = kind === PLANE ? 10 : 3.5;
  const yaw = p.body.yaw;
  let spot: { x: number; z: number; yaw: number } | null = null;
  if (kind === PLANE) spot = planeSpot(p);
  const rings = kind === PLANE ? [9, 14, 22, 30, 45, 60] : [5.5, 9, 14, 22, 30, 45];
  const offs = [0, 0.6, -0.6, 1.2, -1.2, 2, -2, Math.PI];
  if (!spot) outer: for (const dist of rings) {
    for (const o of offs) {
      const a = yaw + o;
      const x = p.body.x - Math.sin(a) * dist;
      const z = p.body.z - Math.cos(a) * dist;
      if (Math.abs(x) > WORLD - 10 || Math.abs(z) > WORLD - 10) continue;
      if (distToBoxes(boxes, x, z) > clear) {
        spot = { x, z, yaw: a };
        break outer;
      }
    }
  }
  if (!spot && kind === PLANE) spot = { x: RUNWAY.x0 + 20, z: RUNWAY.z, yaw: -Math.PI / 2 };
  if (!spot) return say(p, 'Kein freier Platz zum Spawnen');
  p.lastSpawn = t;
  const body = newBody(spot.x, spot.z, spot.yaw, kind);
  vehicles.set(nextId, {
    id: nextId++,
    kind,
    body,
    owner: p.id,
    driver: null,
    hp: kind === PLANE ? 200 : 300,
    emptySince: t,
    burnUntil: 0,
    burnBy: null,
  });
  if (kind === PLANE && Math.hypot(spot.x - p.body.x, spot.z - p.body.z) > 70) {
    say(p, 'Flugzeug steht am Flugplatz (Strasse nach Osten)');
  }
}

function respawn(p: Player) {
  const s = spawnPoint();
  p.body = newBody(s.x, s.z, p.body.yaw);
  p.hp = 100;
  p.protUntil = now() + 2.5;
  refill(p);
}

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
  const inp: Input = {
    seq,
    mx: Number(m.mx) || 0,
    mz: Number(m.mz) || 0,
    yaw: Number(m.yaw) || 0,
    thr: Number(m.thr) || 0,
  };
  const body = controlBody(p);
  step(body, inp, boxes);
  p.ack = seq;
  if (body.crash && p.veh !== null) {
    const v = vehicles.get(p.veh);
    if (v) destroyVehicle(v, null);
  }
}

function onMessage(p: Player, m: any) {
  switch (m.t) {
    case 'in':
      return handleInput(p, m);
    case 'f':
      return fire(p, Number(m.yaw) || 0, Number(m.pitch) || 0);
    case 'enter':
      return p.veh === null ? enter(p) : leave(p);
    case 'spawn':
      return spawnVehicle(p, m.kind === 'plane' ? PLANE : CAR);
    case 'weapon': {
      const c = ctxWeapons(p);
      if (!c) return;
      const i = clamp(Math.floor(Number(m.i) || 0), 0, c.list.length - 1);
      if (c.plane) p.pweapon = i;
      else p.weapon = i;
      return;
    }
    case 'reload':
      return startReload(p);
    case 'ping':
      return send(p.ws, { t: 'pong', c: m.c });
  }
}

// Waffen-HUD des Spielers: Name, Magazin, Nachladefortschritt
function weaponInfo(p: Player) {
  const c = ctxWeapons(p);
  if (!c) return { ctx: 2, wi: 0, wn: 'Keine Waffe im Auto', am: 0, mg: 0, rl: 0 };
  const w = c.list[c.idx];
  const r = p.reload;
  return {
    ctx: c.plane ? 1 : 0,
    wi: c.idx,
    wn: w.name,
    am: c.ammo[c.idx],
    mg: w.mag,
    rl: r ? r2(clamp(1 - (r.until - now()) / r.dur, 0, 1)) : 0,
  };
}

function tick() {
  const t = now();
  // Raketen
  const dt = 1 / TICK_HZ;
  const alive: Proj[] = [];
  for (const pr of projs) {
    let boom = false;
    pr.age += dt;
    pr.dy -= pr.g * dt;
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
          if (q.id === pr.owner || q.hp <= 0 || q.veh !== null) continue;
          if (Math.hypot(q.body.x - pr.x, q.body.y + 1 - pr.y, q.body.z - pr.z) < 1.4) boom = true;
        }
        for (const v of vehicles.values()) {
          if (v.id === pr.ignoreVeh && pr.age < 1.2) continue; // sonst trifft die Rakete das eigene Flugzeug
          if (Math.hypot(v.body.x - pr.x, v.body.y + 1.2 - pr.y, v.body.z - pr.z) < 3) boom = true;
        }
      }
    }
    pr.life -= dt;
    if (boom) explode(pr.x, Math.max(0, pr.y), pr.z, pr.r, pr.dmg, pr.owner);
    else if (pr.life > 0) alive.push(pr);
  }
  projs = alive;

  // Fahrzeuge ohne Fahrer stehen still und verschwinden nach 90 s
  for (const v of [...vehicles.values()]) {
    if (v.driver === null) {
      v.body.speed = 0;
      if (t - v.emptySince > 90) vehicles.delete(v.id);
    }
  }
  // Brennende Fahrzeuge: Insassen nehmen Schaden, nach der Brenndauer knallt es
  for (const v of [...vehicles.values()]) {
    if (v.burnUntil <= 0) continue;
    if (t >= v.burnUntil) {
      destroyVehicle(v, v.burnBy);
      continue;
    }
    const d = v.driver !== null ? players.get(v.driver) : undefined;
    if (d) damagePlayer(d, 14 * (1 / TICK_HZ), v.burnBy);
  }
  finishReloads(t);
  // Respawn
  for (const p of players.values()) if (p.hp <= 0 && t >= p.deadUntil) respawn(p);

  // Snapshot an alle
  const pl = [...players.values()].map((p) => {
    const b = controlBody(p);
    return {
      i: p.id,
      n: p.name,
      h: p.hue,
      x: r2(b.x),
      y: r2(b.y),
      z: r2(b.z),
      yaw: r2(p.veh !== null ? p.body.yaw : b.yaw),
      hp: Math.round(p.hp),
      v: p.veh ?? 0,
      k: p.kills,
      d: p.deaths,
      w: p.weapon,
    };
  });
  const ve = [...vehicles.values()].map((v) => ({
    i: v.id,
    k: v.kind,
    x: r2(v.body.x),
    y: r2(v.body.y),
    z: r2(v.body.z),
    yaw: r2(v.body.yaw),
    p: r2(v.body.pitch),
    r: r2(v.body.roll),
    q: v.kind === PLANE ? [r4(v.body.qx), r4(v.body.qy), r4(v.body.qz), r4(v.body.qw)] : undefined,
    hp: Math.round(v.hp),
    b: v.burnUntil > 0 ? 1 : 0,
    d: v.driver ?? 0,
    o: v.owner,
  }));
  const pr = projs.map((q) => {
    const l = Math.hypot(q.dx, q.dy, q.dz) || 1;
    return { i: q.id, k: q.k, x: r2(q.x), y: r2(q.y), z: r2(q.z), d: [r2(q.dx / l), r2(q.dy / l), r2(q.dz / l)] };
  });
  const ev = events;
  events = [];
  for (const p of players.values()) {
    const b = controlBody(p);
    send(p.ws, {
      t: 's',
      ts: Date.now(),
      ack: p.ack,
      you: {
        x: r2(b.x),
        y: r2(b.y),
        z: r2(b.z),
        yaw: r2(b.yaw),
        pitch: r2(b.pitch),
        roll: r2(b.roll),
        speed: r2(b.speed),
        throttle: r2(b.throttle),
        mode: b.mode,
        crash: false,
        qx: r4(b.qx),
        qy: r4(b.qy),
        qz: r4(b.qz),
        qw: r4(b.qw),
      },
      hp: Math.round(p.hp),
      veh: p.veh ?? 0,
      ...weaponInfo(p),
      pl,
      ve,
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
      const s = spawnPoint();
      const id = nextId++;
      me = {
        id,
        name,
        hue: Math.floor(Math.random() * 360),
        ws,
        body: newBody(s.x, s.z, 0),
        hp: 100,
        weapon: 0,
        pweapon: 0,
        ammo: WEAPONS.map((w) => w.mag),
        pammo: PLANE_WEAPONS.map((w) => w.mag),
        reload: null,
        veh: null,
        ack: 0,
        tokens: 10,
        tokensAt: now(),
        lastFire: 0,
        lastSpawn: 0,
        deadUntil: 0,
        protUntil: now() + 2.5,
        kills: 0,
        deaths: 0,
      };
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
    if (p.veh !== null) {
      const v = vehicles.get(p.veh);
      if (v) {
        v.driver = null;
        v.emptySince = now();
        if (v.kind === PLANE && v.body.y > 2) destroyVehicle(v, null);
      }
    }
    // Fahrzeuge des Spielers verschwinden sofort, wenn niemand darin sitzt
    for (const v of [...vehicles.values()]) if (v.owner === p.id && v.driver === null) vehicles.delete(v.id);
    console.log(`- ${p.name} (${players.size} Spieler)`);
  });
});

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
