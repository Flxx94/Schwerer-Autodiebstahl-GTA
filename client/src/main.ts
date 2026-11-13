// Spiel-Client (Stadtkampf): Netzwerk, Vorhersage (Prediction), Interpolation, Kamera und HUD.
import * as THREE from 'three';
import { buildCity, Box, PICKUPS, WORLD } from '../../shared/map';
import { Body, Input, DT, newBody, copyBody, step } from '../../shared/sim';
import { ctl, initControls } from './controls';
import { createWorld } from './world';
import { loadAssets } from './assets';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const world = createWorld(canvas);

interface PlayerS { i: number; n: string; h: number; x: number; y: number; z: number; yaw: number; hp: number; k: number; d: number; w: number; pr: number }
interface ProjS { i: number; k: number; x: number; y: number; z: number; d: number[] }
interface Snap { t: number; pl: Map<number, PlayerS> }

const WEAPON_NAMES = ['Pistole', 'Sturmgewehr', 'RPG-7'];
const WEAPON_ICONS = ['🔫', '🔫', '🚀'];

let ws: WebSocket | null = null;
let joined = false;
let needInit = true;
let myId = 0;
let myName = '';
let boxes: Box[] = [];
let mapBuilt = false;
let body: Body = newBody(0, 0, 0);
let prev: Body = copyBody(body);
let seq = 0;
let pending: Input[] = [];
let hp = 100;
let wIdx = 0;
let wAmmo = 0;
let wMag = 0;
let wRes = -1;
let wReload = 0;
let wOwn = [1, 0, 0];
let round = { s: 0, t: 0, lim: 20, win: '' };
let pingMs = 0;
let acc = 0;
let lastFireSent = 0;
const snaps: Snap[] = [];
let latestPr: ProjS[] = [];

const objs = {
  pl: new Map<number, THREE.Object3D>(),
  pr: new Map<number, THREE.Object3D>(),
  pk: [] as THREE.Object3D[],
};
let myMesh: THREE.Object3D | null = null;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const lerpAng = (a: number, b: number, k: number) => a + angDiff(a, b) * k;

function send(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------------------------------------------------------------- Verbindung
function connect(name: string, room: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = new URLSearchParams(location.search);
  const host = qs.get('server') ?? (location.port === '5173' ? `${location.hostname}:8080` : location.host);
  $('err').textContent = 'Verbinde …';
  ws = new WebSocket(`${proto}://${host}`);
  ws.onopen = () => send({ t: 'join', name, room });
  ws.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === 's') onSnap(m);
    else if (m.t === 'w') onWelcome(m, name);
    else if (m.t === 'err') $('err').textContent = m.text;
    else if (m.t === 'pong') pingMs = Math.round(performance.now() - m.c);
  };
  ws.onclose = () => {
    if (joined) {
      joined = false;
      $('overlay').style.display = 'flex';
      $('err').textContent = 'Verbindung getrennt. Nochmal auf „Spielen" tippen.';
    } else if ($('err').textContent === 'Verbinde …') {
      $('err').textContent = 'Server nicht erreichbar';
    }
  };
  ws.onerror = () => {
    if (!joined) $('err').textContent = 'Server nicht erreichbar';
  };
}

function onWelcome(m: any, name: string) {
  myId = m.id;
  myName = name;
  if (!mapBuilt) {
    const city = buildCity(m.seed);
    boxes = city.boxes;
    world.addMap(city);
    for (const pk of PICKUPS) {
      const o = world.makePickup(pk.kind);
      o.position.set(pk.x, 0, pk.z);
      world.scene.add(o);
      objs.pk.push(o);
    }
    mapBuilt = true;
  }
  clearObjects();
  snaps.length = 0;
  pending = [];
  needInit = true;
  joined = true;
  $('overlay').style.display = 'none';
  $('err').textContent = '';
}

function clearObjects() {
  for (const g of [objs.pl, objs.pr]) {
    for (const o of g.values()) {
      world.disposeObject(o);
      world.scene.remove(o);
    }
    g.clear();
  }
  if (myMesh) {
    world.disposeObject(myMesh);
    world.scene.remove(myMesh);
  }
  myMesh = null;
}

// ---------------------------------------------------------------- Snapshots
let prevHp = 100;
function onSnap(s: any) {
  const t = performance.now();
  snaps.push({ t, pl: new Map((s.pl as PlayerS[]).map((p) => [p.i, p])) });
  if (snaps.length > 8) snaps.shift();
  latestPr = s.pr;
  hp = s.hp;
  wIdx = s.wi;
  wAmmo = s.am;
  wMag = s.mg;
  wRes = s.rs;
  wReload = s.rl;
  wOwn = s.ow;
  round = s.rd;
  s.pk.forEach((on: number, i: number) => {
    if (objs.pk[i]) objs.pk[i].visible = !!on;
  });
  reconcile(s);
  if (hp < prevHp - 0.5 && hp > 0) flash('dmgFlash');
  prevHp = hp;
  for (const e of s.ev as any[]) onEvent(e);
}

function reconcile(s: any) {
  const sb: Body = { ...s.you };
  pending = pending.filter((i) => i.seq > s.ack);
  if (needInit || hp <= 0) {
    if (needInit) ctl.yaw = sb.yaw;
    body = sb;
    prev = copyBody(sb);
    pending = [];
    needInit = false;
    return;
  }
  const b = copyBody(sb);
  for (const i of pending) step(b, i, boxes);
  const far = Math.hypot(b.x - body.x, b.z - body.z) > 6;
  if (far) {
    body = b;
    prev = copyBody(b);
    return;
  }
  body.x = lerp(body.x, b.x, 0.3);
  body.z = lerp(body.z, b.z, 0.3);
  body.speed = b.speed;
}

// ---------------------------------------------------------------- Ereignisse und HUD
const feed: { text: string; until: number }[] = [];
let toastUntil = 0;

function toast(text: string, ms = 2400) {
  $('toast').textContent = text;
  toastUntil = performance.now() + ms;
}

function flash(id: string) {
  const el = $(id);
  el.classList.remove('go');
  void el.offsetWidth; // Animation neu starten
  el.classList.add('go');
}

function onEvent(e: any) {
  if (e.k === 'shot') {
    world.tracer(e.a, e.b, e.hit, e.wl);
    const shooter = e.by === myId ? myMesh : objs.pl.get(e.by);
    if (shooter) world.playerFired(shooter, e.w);
    if (e.by === myId) navigator.vibrate?.(e.w === 2 ? 25 : 8);
  } else if (e.k === 'rl') {
    const o = e.by === myId ? myMesh : objs.pl.get(e.by);
    if (o) world.playerReload(o, e.d, e.w);
  } else if (e.k === 'hit') {
    if (e.by === myId) {
      flash(e.dead ? 'hitKill' : e.hs ? 'hitHead' : 'hitMark');
      navigator.vibrate?.(e.dead ? 40 : 12);
    }
  } else if (e.k === 'boom') {
    world.boom(e.x, e.y, e.z, e.r);
    if (Math.hypot(e.x - body.x, e.z - body.z) < 25) navigator.vibrate?.(60);
  } else if (e.k === 'pick') {
    if (e.by === myId) toast(['+50 Leben', 'Sturmgewehr aufgenommen', 'RPG-7 aufgenommen'][e.kind]);
    const pk = PICKUPS[e.i];
    if (pk) world.boom(pk.x, 0.5, pk.z, 0.01); // kleiner Funken
  } else if (e.k === 'kill') {
    const how = e.hs ? ' 💀' : '';
    feed.push({ text: e.a ? `${e.a}  ${WEAPON_ICONS[e.w] ?? '➜'}  ${e.b}${how}` : `${e.b} hat es nicht geschafft`, until: performance.now() + 5000 });
    if (e.b === myName) toast(e.a ? `${e.a} hat dich erledigt` : 'Ausgeschaltet');
    else if (e.a === myName) toast(e.s >= 3 ? `${e.b} erledigt – ${e.s}er Serie!` : e.hs ? `Kopfschuss! ${e.b}` : `${e.b} erledigt`);
  } else if (e.k === 'win') {
    toast(e.n ? `${e.n} gewinnt die Runde` : 'Runde vorbei', 6000);
  }
}

function fmtTime(t: number) {
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function updateHud(now: number) {
  const f = $('hpfill');
  f.style.width = `${Math.max(0, hp)}%`;
  f.style.background = hp > 60 ? '#4ade80' : hp > 30 ? '#facc15' : '#f87171';
  // Waffen-HUD
  $('wIcon').textContent = WEAPON_ICONS[wIdx] ?? '';
  $('wName').textContent = WEAPON_NAMES[wIdx] ?? '';
  $('wMag').textContent = String(wAmmo);
  $('wMag').style.color = wAmmo === 0 || wReload > 0 ? '#f87171' : '#fff';
  $('wMagMax').textContent = ` / ${wRes < 0 ? '∞' : wRes}`;
  $('wRel').style.display = wReload > 0 ? 'block' : 'none';
  $('wRelFill').style.width = `${wReload * 100}%`;
  $('wState').textContent = wReload > 0 ? 'Nachladen …' : wAmmo === 0 ? (wRes === 0 ? 'Keine Munition' : 'Leer – nachladen (T)') : '';
  const slots = $('wSlots').children;
  for (let i = 0; i < slots.length; i++) {
    const el = slots[i] as HTMLElement;
    el.classList.toggle('sel', i === wIdx);
    el.classList.toggle('off', !wOwn[i]);
    el.textContent = WEAPON_NAMES[i];
  }
  $('dead').style.display = hp <= 0 && joined ? 'flex' : 'none';
  // Runde
  $('roundTime').textContent = round.s ? 'Rundenende' : fmtTime(round.t);
  const last = snaps[snaps.length - 1];
  const list = last ? [...last.pl.values()].sort((a, b) => b.k - a.k || a.d - b.d) : [];
  const me = list.find((p) => p.i === myId);
  $('roundGoal').textContent = `Ziel: ${round.lim} Kills${me ? ` · du: ${me.k}` : ''}`;
  $('endBoard').style.display = round.s && joined ? 'flex' : 'none';
  if (round.s) {
    $('endBoard').innerHTML =
      `<div class="card"><h2>${round.win ? esc(round.win) + ' gewinnt!' : 'Runde vorbei'}</h2>` +
      list.map((p, i) => `<div class="row"><span>${i + 1}. ${esc(p.n)}</span><span>${p.k} / ${p.d}</span></div>`).join('') +
      `<p>Neue Runde in ${round.t} s</p></div>`;
  }
  while (feed.length && feed[0].until < now) feed.shift();
  $('feed').innerHTML = feed.map((f2) => `<div>${esc(f2.text)}</div>`).join('');
  if (now > toastUntil) $('toast').textContent = '';
  $('score').innerHTML = list
    .slice(0, 6)
    .map((p) => `<div class="${p.i === myId ? 'me' : ''}">${esc(p.n)}  ${p.k}/${p.d}</div>`)
    .join('');
  $('ping').textContent = joined ? `${pingMs} ms` : '';
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

const mm = $<HTMLCanvasElement>('minimap');
const mg = mm.getContext('2d')!;
function drawMinimap() {
  const S = mm.width;
  const scale = 0.7; // Pixel pro Meter
  mg.clearRect(0, 0, S, S);
  mg.save();
  mg.beginPath();
  mg.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  mg.clip();
  mg.fillStyle = 'rgba(40,60,40,.55)';
  mg.fillRect(0, 0, S, S);
  const px = (x: number) => S / 2 + (x - body.x) * scale;
  const pz = (z: number) => S / 2 + (z - body.z) * scale;
  // Arena-Rand
  mg.strokeStyle = 'rgba(255,90,90,.8)';
  mg.lineWidth = 2;
  mg.strokeRect(px(-WORLD), pz(-WORLD), WORLD * 2 * scale, WORLD * 2 * scale);
  mg.fillStyle = 'rgba(200,200,210,.55)';
  for (const b of boxes) {
    const x = px(b.x - b.hw);
    const z = pz(b.z - b.hd);
    if (x > S || z > S || x < -40 || z < -40) continue;
    mg.fillRect(x, z, b.hw * 2 * scale, b.hd * 2 * scale);
  }
  // Gegenstaende
  const cols = ['#5bff8a', '#ffd24a', '#ff8a3d'];
  PICKUPS.forEach((pk, i) => {
    if (!objs.pk[i]?.visible) return;
    mg.fillStyle = cols[pk.kind];
    mg.fillRect(px(pk.x) - 3, pz(pk.z) - 3, 6, 6);
  });
  const last = snaps[snaps.length - 1];
  if (last) {
    mg.fillStyle = '#ff5a5a';
    for (const p of last.pl.values()) {
      if (p.i === myId || p.hp <= 0) continue;
      mg.beginPath();
      mg.arc(px(p.x), pz(p.z), 4, 0, Math.PI * 2);
      mg.fill();
    }
  }
  mg.fillStyle = '#ffffff';
  mg.beginPath();
  mg.arc(S / 2, S / 2, 5, 0, Math.PI * 2);
  mg.fill();
  mg.strokeStyle = '#fff';
  mg.lineWidth = 3;
  mg.beginPath();
  mg.moveTo(S / 2, S / 2);
  mg.lineTo(S / 2 - Math.sin(ctl.yaw) * 18, S / 2 - Math.cos(ctl.yaw) * 18);
  mg.stroke();
  mg.restore();
}

// ---------------------------------------------------------------- Simulation (feste Schritte)
function tick() {
  if (!joined || needInit) return;
  prev = copyBody(body);
  if (hp > 0) {
    const inp: Input = { seq: ++seq, mx: ctl.mx, mz: ctl.mz, yaw: ctl.yaw };
    step(body, inp, boxes);
    pending.push(inp);
    if (pending.length > 90) pending.shift();
    send({ t: 'in', ...inp });
    const now = performance.now();
    if (ctl.fire && now - lastFireSent >= 70) {
      lastFireSent = now;
      send({ t: 'f', yaw: ctl.yaw, pitch: ctl.pitch });
    }
  }
}

// ---------------------------------------------------------------- Darstellung
function interp(id: number, rt: number): PlayerS | undefined {
  let a: PlayerS | undefined;
  let b: PlayerS | undefined;
  let ta = 0;
  let tb = 0;
  for (let i = snaps.length - 1; i >= 0; i--) {
    const e = snaps[i].pl.get(id);
    if (!e) continue;
    if (snaps[i].t <= rt) {
      a = e;
      ta = snaps[i].t;
      break;
    }
    b = e;
    tb = snaps[i].t;
  }
  if (a && b) {
    const k = Math.min(1, Math.max(0, (rt - ta) / (tb - ta || 1)));
    return { ...b, x: lerp(a.x, b.x, k), z: lerp(a.z, b.z, k), yaw: lerpAng(a.yaw, b.yaw, k) };
  }
  return a ?? b;
}

function syncObjects(rt: number, alpha: number, dt: number) {
  const last = snaps[snaps.length - 1];
  if (!last) return;
  const nowMs = performance.now();
  // Mitspieler
  for (const [id, o] of objs.pl) {
    if (!last.pl.has(id) || id === myId) {
      world.disposeObject(o);
      world.scene.remove(o);
      objs.pl.delete(id);
    }
  }
  for (const p of last.pl.values()) {
    if (p.i === myId) continue;
    let o = objs.pl.get(p.i);
    if (!o) {
      o = world.makePlayer(p.n, p.h, p.i);
      world.scene.add(o);
      objs.pl.set(p.i, o);
    }
    const s = interp(p.i, rt) ?? p;
    if (p.hp <= 0) o.userData.deadAt ??= nowMs;
    else o.userData.deadAt = undefined;
    // Gefallene bleiben noch 3 Sekunden liegen, dann verschwinden sie; Spawnschutz blinkt
    o.visible = (p.hp > 0 || nowMs - o.userData.deadAt < 3000) && !(p.pr && Math.floor(nowMs / 110) % 2);
    const d = Math.max(dt, 0.001);
    const vx = (s.x - (o.userData.px ?? s.x)) / d;
    const vz = (s.z - (o.userData.pz ?? s.z)) / d;
    o.userData.px = s.x;
    o.userData.pz = s.z;
    o.userData.vx = (o.userData.vx ?? 0) * 0.75 + vx * 0.25;
    o.userData.vz = (o.userData.vz ?? 0) * 0.75 + vz * 0.25;
    o.position.set(s.x, 0, s.z);
    world.animatePlayer(o, { vx: o.userData.vx, vz: o.userData.vz, yaw: s.yaw, dead: p.hp <= 0, dt, weapon: p.w ?? 0 });
  }
  // Eigene Figur
  const me = last.pl.get(myId);
  if (me && !myMesh) {
    myMesh = world.makePlayer('', me.h, myId);
    world.scene.add(myMesh);
  }
  if (myMesh) {
    if (hp <= 0) myMesh.userData.deadAt ??= nowMs;
    else myMesh.userData.deadAt = undefined;
    myMesh.visible = (hp > 0 || nowMs - myMesh.userData.deadAt < 3000) && !(me?.pr && Math.floor(nowMs / 110) % 2);
    myMesh.position.set(lerp(prev.x, body.x, alpha), 0, lerp(prev.z, body.z, alpha));
    const on = hp > 0;
    world.animatePlayer(myMesh, { vx: on ? (body.x - prev.x) / DT : 0, vz: on ? (body.z - prev.z) / DT : 0, yaw: ctl.yaw, dead: hp <= 0, dt, weapon: wIdx });
  }
  // Gegenstaende drehen sich
  for (const o of objs.pk) if (o.visible) o.rotation.y = nowMs / 700;
  // RPG-Granaten
  const seen = new Set<number>();
  for (const p of latestPr) {
    seen.add(p.i);
    let o = objs.pr.get(p.i);
    if (!o) {
      o = world.makeProjectile(0);
      world.scene.add(o);
      objs.pr.set(p.i, o);
    }
    o.position.set(p.x, p.y, p.z);
    o.lookAt(p.x + p.d[0], p.y + p.d[1], p.z + p.d[2]);
    world.projectileFx(o, 0, dt);
  }
  for (const [id, o] of objs.pr) {
    if (!seen.has(id)) {
      world.disposeObject(o);
      world.scene.remove(o);
      objs.pr.delete(id);
    }
  }
}

function updateCamera(alpha: number) {
  const c = world.camera;
  if (!joined || needInit) {
    const t = performance.now() / 12000;
    c.position.set(Math.cos(t) * 140, 70, Math.sin(t) * 140);
    c.lookAt(0, 10, 0);
    return;
  }
  const px = lerp(prev.x, body.x, alpha);
  const pz = lerp(prev.z, body.z, alpha);
  c.fov = 60;
  c.updateProjectionMatrix();
  const cp = Math.cos(ctl.pitch);
  const dx = -Math.sin(ctl.yaw) * cp;
  const dy = Math.sin(ctl.pitch);
  const dz = -Math.cos(ctl.yaw) * cp;
  const rx = Math.cos(ctl.yaw);
  const rz = -Math.sin(ctl.yaw);
  const ex = px + rx * 0.75;
  const ey = 1.55;
  const ez = pz + rz * 0.75;
  // Kamera dicht hinter der Figur; stoesst sie an eine Wand, rueckt sie heran
  let dist = 3.7;
  for (; dist > 1.0; dist -= 0.35) {
    const cx = ex - dx * dist;
    const cy = Math.max(0.5, ey - dy * dist + 0.25);
    const cz = ez - dz * dist;
    if (!boxes.some((b) => Math.abs(cx - b.x) < b.hw + 0.4 && Math.abs(cz - b.z) < b.hd + 0.4 && cy < b.h)) break;
  }
  c.position.set(ex - dx * dist, Math.max(0.5, ey - dy * dist + 0.25), ez - dz * dist);
  c.lookAt(ex + dx * 30, ey + dy * 30 + 0.1, ez + dz * 30);
}

let last = performance.now();
let mmAt = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (joined) {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      tick();
    }
  }
  const alpha = Math.min(1, acc / DT);
  syncObjects(now - 100, alpha, dt);
  updateCamera(alpha);
  world.focus(world.camera.position.x * 0.5 + lerp(prev.x, body.x, alpha) * 0.5, 0, world.camera.position.z * 0.5 + lerp(prev.z, body.z, alpha) * 0.5);
  world.update(now, dt);
  world.renderer.render(world.scene, world.camera);
  updateHud(now);
  if (joined && now - mmAt > 100) {
    mmAt = now;
    drawMinimap();
  }
}

// ---------------------------------------------------------------- Start
initControls({
  next: () => send({ t: 'next' }),
  select: (i) => send({ t: 'weapon', i }),
  reload: () => send({ t: 'reload' }),
});

const nameEl = $<HTMLInputElement>('name');
const roomEl = $<HTMLInputElement>('room');
try {
  nameEl.value = localStorage.getItem('sa.name') ?? '';
  roomEl.value = localStorage.getItem('sa.room') ?? '';
} catch {
  /* Speicher kann gesperrt sein */
}
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) roomEl.value = urlRoom;

// Grafik laden (KayKit-Modelle). Klappt es nicht, laeuft das Spiel mit einfachen Klotz-Modellen.
let assetsReady = false;
const playBtn = $<HTMLButtonElement>('play');
playBtn.disabled = true;
$('err').textContent = 'Lade Grafik …';
loadAssets().then((a) => {
  world.setAssets(a);
  assetsReady = true;
  playBtn.disabled = false;
  $('err').textContent = a ? '' : 'Grafik konnte nicht geladen werden, einfache Darstellung';
});

const play = () => {
  if (!assetsReady) return;
  const name = nameEl.value.trim();
  const room = roomEl.value.trim();
  if (!name) {
    $('err').textContent = 'Bitte einen Namen eingeben';
    return;
  }
  try {
    localStorage.setItem('sa.name', name);
    localStorage.setItem('sa.room', room);
  } catch {
    /* egal */
  }
  ws?.close();
  connect(name, room);
};
$('play').addEventListener('click', play);
roomEl.addEventListener('keydown', (e) => e.key === 'Enter' && play());
setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
requestAnimationFrame(frame);

// Fuer Tests und Debugging in der Konsole
(window as any).__game = {
  ctl,
  world,
  get boxes() { return boxes; },
  get info() { return { ...world.renderer.info.render, geometries: world.renderer.info.memory.geometries, textures: world.renderer.info.memory.textures }; },
  get body() { return body; },
  get hp() { return hp; },
  get snaps() { return snaps.length; },
  WORLD,
};
