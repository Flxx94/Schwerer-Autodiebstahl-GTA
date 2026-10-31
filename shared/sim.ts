// Gemeinsame Bewegungslogik. Server und Client rufen dieselbe step()-Funktion auf,
// damit die Vorhersage auf dem Handy mit dem Server uebereinstimmt.
import { Box, WORLD } from './map';

export const DT = 1 / 30; // feste Schrittweite in Sekunden

export const FOOT = 0;
export const CAR = 1;
export const PLANE = 2;
export type Mode = 0 | 1 | 2;

export interface Body {
  x: number;
  y: number;
  z: number;
  yaw: number; // 0 = blickt nach -z, positiv = nach links drehen
  pitch: number; // positiv = Nase hoch
  roll: number; // positiv = Rechtskurve
  speed: number; // m/s in Fahrtrichtung
  throttle: number; // 0..1 (Flugzeug)
  mode: Mode;
  crash: boolean;
}

export interface Input {
  seq: number;
  mx: number; // -1 links .. 1 rechts
  mz: number; // -1 zurueck .. 1 vor
  yaw: number; // Blickrichtung (nur zu Fuss)
  thr: number; // Schubregler 0..1 (nur Flugzeug)
}

export const FOOT_SPEED = 7;
export const CAR_MAX = 30;
export const PLANE_STALL = 18;
export const PLANE_TAKEOFF = 20;
export const PLANE_MAX = 65;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function newBody(x: number, z: number, yaw: number, mode: Mode = FOOT): Body {
  return { x, y: 0, z, yaw, pitch: 0, roll: 0, speed: 0, throttle: 0, mode, crash: false };
}

export function copyBody(b: Body): Body {
  return { ...b };
}

// Schiebt den Koerper (Kreis mit Radius r) aus Gebaeuden heraus. Gibt true bei Kontakt zurueck.
export function collide(b: Body, boxes: Box[], r: number): boolean {
  let hit = false;
  for (const box of boxes) {
    if (b.y > box.h) continue;
    const nx = clamp(b.x, box.x - box.hw, box.x + box.hw);
    const nz = clamp(b.z, box.z - box.hd, box.z + box.hd);
    const dx = b.x - nx;
    const dz = b.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    hit = true;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      b.x = nx + (dx / d) * r;
      b.z = nz + (dz / d) * r;
    } else {
      const px = box.hw - Math.abs(b.x - box.x);
      const pz = box.hd - Math.abs(b.z - box.z);
      if (px < pz) b.x = box.x + Math.sign(b.x - box.x || 1) * (box.hw + r);
      else b.z = box.z + Math.sign(b.z - box.z || 1) * (box.hd + r);
    }
  }
  return hit;
}

export function step(b: Body, inp: Input, boxes: Box[]): void {
  const mx = clamp(inp.mx, -1, 1);
  const mz = clamp(inp.mz, -1, 1);
  if (b.mode === FOOT) stepFoot(b, inp, mx, mz, boxes);
  else if (b.mode === CAR) stepCar(b, mx, mz, boxes);
  else stepPlane(b, inp, mx, mz, boxes);
  b.x = clamp(b.x, -WORLD, WORLD);
  b.z = clamp(b.z, -WORLD, WORLD);
}

function stepFoot(b: Body, inp: Input, mx: number, mz: number, boxes: Box[]) {
  b.yaw = inp.yaw;
  const s = Math.sin(b.yaw);
  const c = Math.cos(b.yaw);
  let vx = -s * mz + c * mx;
  let vz = -c * mz - s * mx;
  const l = Math.hypot(vx, vz);
  if (l > 1) {
    vx /= l;
    vz /= l;
  }
  b.x += vx * FOOT_SPEED * DT;
  b.z += vz * FOOT_SPEED * DT;
  b.speed = Math.min(l, 1) * FOOT_SPEED;
  b.y = 0;
  b.pitch = 0;
  b.roll = 0;
  collide(b, boxes, 0.5);
}

function stepCar(b: Body, mx: number, mz: number, boxes: Box[]) {
  if (mz > 0.05) {
    b.speed += (b.speed < 0 ? 30 : 16) * mz * DT;
  } else if (mz < -0.05) {
    b.speed -= (b.speed > 0.5 ? 28 : 10) * -mz * DT;
  } else {
    b.speed *= 1 - 0.8 * DT;
    if (Math.abs(b.speed) < 0.1) b.speed = 0;
  }
  b.speed = clamp(b.speed, -10, CAR_MAX);
  b.yaw -= mx * 1.9 * clamp(b.speed / 7, -1, 1) * DT;
  b.x += -Math.sin(b.yaw) * b.speed * DT;
  b.z += -Math.cos(b.yaw) * b.speed * DT;
  b.y = 0;
  b.pitch = 0;
  b.roll = 0;
  if (collide(b, boxes, 2.2)) b.speed *= -0.25;
}

function stepPlane(b: Body, inp: Input, mx: number, mz: number, boxes: Box[]) {
  b.throttle = clamp(inp.thr, 0, 1);
  const target = b.throttle * PLANE_MAX;
  b.speed += clamp(target - b.speed, -12 * DT, 18 * DT);
  const grounded = b.y <= 0.01;
  if (grounded) {
    b.roll = 0;
    const lift = mz > 0.3 && b.speed >= PLANE_TAKEOFF;
    b.pitch += ((lift ? 0.35 : 0) - b.pitch) * Math.min(1, (lift ? 2 : 6) * DT);
    b.yaw -= mx * 1.0 * clamp(b.speed / 15, 0, 1) * DT;
  } else {
    const stalled = b.speed < PLANE_STALL;
    const tp = stalled ? -0.6 : mz * 0.55;
    b.pitch += (tp - b.pitch) * Math.min(1, 1.8 * DT);
    b.roll += (mx * 0.9 - b.roll) * Math.min(1, 3 * DT);
    b.yaw -= b.roll * 1.1 * DT;
  }
  const cp = Math.cos(b.pitch);
  b.x += -Math.sin(b.yaw) * cp * b.speed * DT;
  b.z += -Math.cos(b.yaw) * cp * b.speed * DT;
  b.y += Math.sin(b.pitch) * b.speed * DT;
  if (!grounded && b.speed < PLANE_STALL) b.y -= ((PLANE_STALL - b.speed) / PLANE_STALL) * 20 * DT;
  if (b.y <= 0) {
    if (!grounded && (b.pitch < -0.3 || (b.speed > 30 && b.pitch < -0.15))) b.crash = true;
    b.y = 0;
    if (b.pitch < 0) b.pitch = 0;
  }
  if (b.y > 250) b.y = 250;
  for (const box of boxes) {
    if (b.y < box.h && Math.abs(b.x - box.x) < box.hw + 1.5 && Math.abs(b.z - box.z) < box.hd + 1.5) {
      b.crash = true;
      break;
    }
  }
}
