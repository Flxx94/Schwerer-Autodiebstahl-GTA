// Gemeinsame Bewegungslogik. Server und Client rufen dieselbe step()-Funktion auf,
// damit die Vorhersage auf dem Handy mit dem Server uebereinstimmt.
import { Box, WORLD } from './map';

export const DT = 1 / 30; // feste Schrittweite in Sekunden

export interface Body {
  x: number;
  y: number;
  z: number;
  yaw: number; // 0 = blickt nach -z, positiv = nach links drehen
  speed: number; // m/s
}

export interface Input {
  seq: number;
  mx: number; // -1 links .. 1 rechts
  mz: number; // -1 zurueck .. 1 vor
  yaw: number; // Blickrichtung
}

export const FOOT_SPEED = 7;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function newBody(x: number, z: number, yaw: number): Body {
  return { x, y: 0, z, yaw, speed: 0 };
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
  collide(b, boxes, 0.5);
  b.x = clamp(b.x, -WORLD + 1, WORLD - 1);
  b.z = clamp(b.z, -WORLD + 1, WORLD - 1);
}
