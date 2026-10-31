// Spiel-Client: Netzwerk, Vorhersage (Prediction), Interpolation, Kamera und HUD.
import * as THREE from 'three';
import { buildCity, Box, WORLD } from '../../shared/map';
import { Body, Input, DT, FOOT, CAR, PLANE, newBody, copyBody, step } from '../../shared/sim';
import { ctl, initControls, setThrottle, setThrottleVisible } from './controls';
import { createWorld } from './world';
import { loadAssets } from './assets';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const world = createWorld(canvas);

interface PlayerS { i: number; n: string; h: number; x: number; y: number; z: number; yaw: number; hp: number; v: number; k: number; d: number; w: number }
interface VehS { i: number; k: number; x: number; y: number; z: number; yaw: number; p: number; r: number; hp: number; d: number; o: number }
interface ProjS { i: number; x: number; y: number; z: number }
interface Snap { t: number; pl: Map<number, PlayerS>; ve: Map<number, VehS> }

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
let myVeh = 0;
let weaponName = '';
let weaponIdx = 0;
let pingMs = 0;
let acc = 0;
let lastFireSent = 0;
const snaps: Snap[] = [];
let latestPr: ProjS[] = [];

const objs = {
  pl: new Map<number, THREE.Object3D>(),
  ve: new Map<number, THREE.Object3D>(),
  pr: new Map<number, THREE.Object3D>(),
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
    else if (m.t === 'msg') toast(m.text);
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
  for (const g of [objs.pl, objs.ve, objs.pr]) {
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
function onSnap(s: any) {
  const t = performance.now();
  snaps.push({ t, pl: new Map((s.pl as PlayerS[]).map((p) => [p.i, p])), ve: new Map((s.ve as VehS[]).map((v) => [v.i, v])) });
  if (snaps.length > 8) snaps.shift();
  latestPr = s.pr;
  hp = s.hp;
  myVeh = s.veh;
  weaponName = s.wn;
  weaponIdx = s.wi;
  reconcile(s);
  for (const e of s.ev as any[]) onEvent(e);
}

function reconcile(s: any) {
  const sb: Body = { ...s.you, crash: false };
  pending = pending.filter((i) => i.seq > s.ack);
  if (needInit || hp <= 0) {
    if (needInit && sb.mode === FOOT) ctl.yaw = sb.yaw;
    body = sb;
    prev = copyBody(sb);
    pending = [];
    needInit = false;
    return;
  }
  const b = copyBody(sb);
  for (const i of pending) step(b, i, boxes);
  b.crash = false;
  const far = Math.hypot(b.x - body.x, b.y - body.y, b.z - body.z) > 6;
  if (b.mode !== body.mode || far) {
    if (body.mode !== FOOT && b.mode === FOOT) ctl.yaw = body.yaw; // nach dem Aussteigen in Fahrtrichtung schauen
    if (b.mode === PLANE && body.mode !== PLANE) setThrottle(0);
    body = b;
    prev = copyBody(b);
    return;
  }
  body.x = lerp(body.x, b.x, 0.3);
  body.y = lerp(body.y, b.y, 0.3);
  body.z = lerp(body.z, b.z, 0.3);
  body.pitch = b.pitch;
  body.roll = b.roll;
  body.speed = b.speed;
  body.throttle = b.throttle;
  if (body.mode !== FOOT) body.yaw = b.yaw;
}

// ---------------------------------------------------------------- Ereignisse und HUD
const feed: { text: string; until: number }[] = [];
let toastUntil = 0;

function toast(text: string) {
  $('toast').textContent = text;
  toastUntil = performance.now() + 2600;
}

function onEvent(e: any) {
  if (e.k === 'shot') {
    world.tracer(e.a, e.b);
    const shooter = e.by === myId ? myMesh : objs.pl.get(e.by);
    if (shooter) world.playerFired(shooter);
    if (e.by === myId) navigator.vibrate?.(8);
  } else if (e.k === 'boom') {
    world.boom(e.x, e.y, e.z, e.r);
    if (Math.hypot(e.x - body.x, e.z - body.z) < 25) navigator.vibrate?.(60);
  } else if (e.k === 'kill') {
    feed.push({ text: e.a ? `${e.a}  ➜  ${e.b}` : `${e.b} hat es nicht geschafft`, until: performance.now() + 5000 });
    if (e.b === myName) toast('Ausgeschaltet');
    else if (e.a === myName) toast(`${e.b} erledigt`);
  }
}

let lastEnterLabel = '';
let lastThrVisible = false;
function updateHud(now: number) {
  const f = $('hpfill');
  f.style.width = `${Math.max(0, hp)}%`;
  f.style.background = hp > 60 ? '#4ade80' : hp > 30 ? '#facc15' : '#f87171';
  $('weaponName').textContent = weaponName;
  $('dead').style.display = hp <= 0 && joined ? 'flex' : 'none';
  const sp = $('speedo');
  if (body.mode === CAR) sp.textContent = `${Math.round(Math.abs(body.speed) * 3.6)} km/h`;
  else if (body.mode === PLANE) sp.textContent = `${Math.round(body.speed * 3.6)} km/h · ${Math.round(body.y)} m`;
  else sp.textContent = '';
  const label = myVeh ? 'Aussteigen' : 'Einsteigen';
  if (label !== lastEnterLabel) {
    $('btnEnter').textContent = label;
    lastEnterLabel = label;
  }
  const thrVis = body.mode === PLANE;
  if (thrVis !== lastThrVisible) {
    setThrottleVisible(thrVis);
    lastThrVisible = thrVis;
  }
  while (feed.length && feed[0].until < now) feed.shift();
  $('feed').innerHTML = feed.map((f2) => `<div>${esc(f2.text)}</div>`).join('');
  if (now > toastUntil) $('toast').textContent = '';
  const last = snaps[snaps.length - 1];
  if (last) {
    const list = [...last.pl.values()].sort((a, b) => b.k - a.k).slice(0, 6);
    $('score').textContent = list.map((p) => `${p.n}  ${p.k}/${p.d}`).join('\n');
  }
  $('ping').textContent = joined ? `${pingMs} ms` : '';
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

const mm = $<HTMLCanvasElement>('minimap');
const mg = mm.getContext('2d')!;
function drawMinimap() {
  const S = mm.width;
  const scale = 0.45; // Pixel pro Meter
  mg.clearRect(0, 0, S, S);
  mg.save();
  mg.beginPath();
  mg.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  mg.clip();
  mg.fillStyle = 'rgba(40,60,40,.55)';
  mg.fillRect(0, 0, S, S);
  const px = (x: number) => S / 2 + (x - body.x) * scale;
  const pz = (z: number) => S / 2 + (z - body.z) * scale;
  mg.fillStyle = 'rgba(200,200,210,.55)';
  for (const b of boxes) {
    const x = px(b.x - b.hw);
    const z = pz(b.z - b.hd);
    if (x > S || z > S || x < -40 || z < -40) continue;
    mg.fillRect(x, z, b.hw * 2 * scale, b.hd * 2 * scale);
  }
  const last = snaps[snaps.length - 1];
  if (last) {
    mg.fillStyle = '#9aa3ad';
    for (const v of last.ve.values()) mg.fillRect(px(v.x) - 3, pz(v.z) - 3, 6, 6);
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
  const yaw = body.mode === FOOT ? ctl.yaw : body.yaw;
  mg.strokeStyle = '#fff';
  mg.lineWidth = 3;
  mg.beginPath();
  mg.moveTo(S / 2, S / 2);
  mg.lineTo(S / 2 - Math.sin(yaw) * 18, S / 2 - Math.cos(yaw) * 18);
  mg.stroke();
  mg.restore();
}

// ---------------------------------------------------------------- Simulation (feste Schritte)
function tick() {
  if (!joined || needInit) return;
  prev = copyBody(body);
  if (hp > 0) {
    const inp: Input = { seq: ++seq, mx: ctl.mx, mz: ctl.mz, yaw: ctl.yaw, thr: ctl.thr };
    step(body, inp, boxes);
    body.crash = false;
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
function interp(kind: 'pl' | 've', id: number, rt: number): any {
  let a: any = null;
  let b: any = null;
  let ta = 0;
  let tb = 0;
  for (let i = snaps.length - 1; i >= 0; i--) {
    const e = snaps[i][kind].get(id);
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
    return {
      ...b,
      x: lerp(a.x, b.x, k),
      y: lerp(a.y, b.y, k),
      z: lerp(a.z, b.z, k),
      yaw: lerpAng(a.yaw, b.yaw, k),
      p: lerp(a.p ?? 0, b.p ?? 0, k),
      r: lerp(a.r ?? 0, b.r ?? 0, k),
    };
  }
  return a ?? b;
}

function syncObjects(rt: number, alpha: number, dt: number) {
  const last = snaps[snaps.length - 1];
  if (!last) return;
  // Spieler
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
    const s = interp('pl', p.i, rt) ?? p;
    o.visible = p.hp > 0 && p.v === 0;
    const spd = Math.hypot(s.x - (o.userData.px ?? s.x), s.z - (o.userData.pz ?? s.z)) / Math.max(dt, 0.001);
    o.userData.px = s.x;
    o.userData.pz = s.z;
    o.userData.spd = (o.userData.spd ?? 0) * 0.7 + spd * 0.3;
    o.position.set(s.x, s.y, s.z);
    o.rotation.y = s.yaw;
    world.animatePlayer(o, { speed: o.userData.spd, dead: p.hp <= 0 });
  }
  // Eigene Figur
  const me = last.pl.get(myId);
  if (me && !myMesh) {
    myMesh = world.makePlayer('', me.h, myId);
    world.scene.add(myMesh);
  }
  if (myMesh) {
    myMesh.visible = hp > 0 && myVeh === 0;
    myMesh.position.set(lerp(prev.x, body.x, alpha), 0, lerp(prev.z, body.z, alpha));
    myMesh.rotation.y = ctl.yaw;
    world.animatePlayer(myMesh, { speed: body.mode === FOOT ? body.speed : 0, dead: hp <= 0 });
  }
  // Fahrzeuge
  for (const [id, o] of objs.ve) {
    if (!last.ve.has(id)) {
      world.disposeObject(o);
      world.scene.remove(o);
      objs.ve.delete(id);
    }
  }
  for (const v of last.ve.values()) {
    let o = objs.ve.get(v.i);
    if (!o) {
      const hue = last.pl.get(v.o)?.h ?? 30;
      o = v.k === PLANE ? world.makePlane(hue) : world.makeCar(hue, v.i);
      o.rotation.order = 'YXZ';
      world.scene.add(o);
      objs.ve.set(v.i, o);
    }
    let vx: number, vz: number, vyaw: number;
    if (v.i === myVeh && body.mode !== FOOT) {
      vx = lerp(prev.x, body.x, alpha);
      vz = lerp(prev.z, body.z, alpha);
      o.position.set(vx, lerp(prev.y, body.y, alpha), vz);
      o.rotation.set(body.pitch, body.yaw, -body.roll);
      vyaw = body.yaw;
    } else {
      const s = interp('ve', v.i, rt) ?? v;
      vx = s.x;
      vz = s.z;
      o.position.set(s.x, s.y, s.z);
      o.rotation.set(s.p, s.yaw, -s.r);
      vyaw = s.yaw;
    }
    if (v.k === CAR) {
      const mvx = vx - (o.userData.lx ?? vx);
      const mvz = vz - (o.userData.lz ?? vz);
      world.spinWheels(o, mvx * -Math.sin(vyaw) + mvz * -Math.cos(vyaw));
      o.userData.lx = vx;
      o.userData.lz = vz;
    }
  }
  // Raketen
  const seen = new Set<number>();
  for (const p of latestPr) {
    seen.add(p.i);
    let o = objs.pr.get(p.i);
    if (!o) {
      o = world.makeRocket();
      world.scene.add(o);
      objs.pr.set(p.i, o);
    }
    o.position.set(p.x, p.y, p.z);
  }
  for (const [id, o] of objs.pr) {
    if (!seen.has(id)) {
      world.scene.remove(o);
      objs.pr.delete(id);
    }
  }
}

const cam = { yaw: 0, pitch: 0 };
function updateCamera(alpha: number, dt: number) {
  const c = world.camera;
  if (!joined || needInit) {
    const t = performance.now() / 12000;
    c.position.set(Math.cos(t) * 140, 70, Math.sin(t) * 140);
    c.lookAt(0, 10, 0);
    return;
  }
  const px = lerp(prev.x, body.x, alpha);
  const py = lerp(prev.y, body.y, alpha);
  const pz = lerp(prev.z, body.z, alpha);
  const k = 1 - Math.exp(-6 * dt);
  if (body.mode === FOOT) {
    const cp = Math.cos(ctl.pitch);
    const dx = -Math.sin(ctl.yaw) * cp;
    const dy = Math.sin(ctl.pitch);
    const dz = -Math.cos(ctl.yaw) * cp;
    const rx = Math.cos(ctl.yaw);
    const rz = -Math.sin(ctl.yaw);
    const ex = px + rx * 0.7;
    const ey = py + 1.6;
    const ez = pz + rz * 0.7;
    c.position.set(ex - dx * 5.2, Math.max(0.5, ey - dy * 5.2 + 0.4), ez - dz * 5.2);
    c.lookAt(ex + dx * 30, ey + dy * 30, ez + dz * 30);
    cam.yaw = ctl.yaw;
  } else if (body.mode === CAR) {
    cam.yaw = lerpAng(cam.yaw, body.yaw, k);
    c.position.set(px + Math.sin(cam.yaw) * 9, py + 4.2, pz + Math.cos(cam.yaw) * 9);
    c.lookAt(px - Math.sin(cam.yaw) * 6, py + 1.5, pz - Math.cos(cam.yaw) * 6);
  } else {
    cam.yaw = lerpAng(cam.yaw, body.yaw, k);
    cam.pitch = lerp(cam.pitch, body.pitch * 0.6, k);
    const cp = Math.cos(cam.pitch);
    const dx = -Math.sin(cam.yaw) * cp;
    const dy = Math.sin(cam.pitch);
    const dz = -Math.cos(cam.yaw) * cp;
    c.position.set(px - dx * 17, Math.max(1, py - dy * 17 + 4.5), pz - dz * 17);
    c.lookAt(px + dx * 25, py + dy * 25 + 1, pz + dz * 25);
  }
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
  updateCamera(alpha, dt);
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
  enter: () => send({ t: 'enter' }),
  spawn: (kind) => send({ t: 'spawn', kind }),
  weapon: () => send({ t: 'weapon', i: (weaponIdx + 1) % 3 }),
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
(window as any).__game = { ctl, get info() { return { ...world.renderer.info.render, calls: world.renderer.info.render.calls, geometries: world.renderer.info.memory.geometries, textures: world.renderer.info.memory.textures }; }, get body() { return body; }, get hp() { return hp; }, get snaps() { return snaps.length; }, WORLD };
