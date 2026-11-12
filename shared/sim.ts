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
  // Fluglage des Flugzeugs als Quaternion (x, y, z, w). Damit sind Rollen und Loopings moeglich;
  // yaw, pitch und roll werden daraus abgeleitet (fuer Anzeige, Minikarte und Server-Logik).
  qx: number;
  qy: number;
  qz: number;
  qw: number;
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
  const b: Body = { x, y: 0, z, yaw, pitch: 0, roll: 0, speed: 0, throttle: 0, mode, crash: false, qx: 0, qy: 0, qz: 0, qw: 1 };
  setEuler(b);
  return b;
}

// ---- kleine Quaternion-Helfer (x, y, z, w) ----
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qaxis = (x: number, y: number, z: number, ang: number): Q => {
  const l = Math.hypot(x, y, z) || 1;
  const s = Math.sin(ang / 2) / l;
  return [x * s, y * s, z * s, Math.cos(ang / 2)];
};
const qnorm = (q: Q): Q => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const qrot = (q: Q, v: [number, number, number]): [number, number, number] => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const getQ = (b: Body): Q => [b.qx, b.qy, b.qz, b.qw];
const putQ = (b: Body, q: Q) => {
  b.qx = q[0];
  b.qy = q[1];
  b.qz = q[2];
  b.qw = q[3];
};

// Flugzeug-Achsen in Weltkoordinaten: vorwaerts (Nase), oben, rechts
export function planeAxes(b: Body) {
  const q = getQ(b);
  return { f: qrot(q, [0, 0, -1]), u: qrot(q, [0, 1, 0]), r: qrot(q, [1, 0, 0]) };
}

// Fluglage aus yaw und pitch (ohne Rolle) setzen
function setEuler(b: Body) {
  putQ(b, qnorm(qmul(qaxis(0, 1, 0, b.yaw), qaxis(1, 0, 0, b.pitch))));
}

// yaw, pitch und roll aus der Fluglage ableiten
function deriveAngles(b: Body) {
  const { f, u, r } = planeAxes(b);
  b.yaw = Math.atan2(-f[0], -f[2]);
  b.pitch = Math.asin(clamp(f[1], -1, 1));
  b.roll = Math.atan2(-r[1], u[1]); // positiv = rechter Fluegel unten
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

export const PLANE_PITCH_RATE = 1.75; // rad/s bei voller Auslenkung (ein Looping dauert ca. 3,6 s)
export const PLANE_ROLL_RATE = 3.2; // rad/s (eine Fassrolle dauert ca. 2 s)

function stepPlane(b: Body, inp: Input, mx: number, mz: number, boxes: Box[]) {
  b.throttle = clamp(inp.thr, 0, 1);
  const target = b.throttle * PLANE_MAX;
  const grounded = b.y <= 0.01;
  if (grounded) {
    b.speed += clamp(target - b.speed, -12 * DT, 18 * DT);
    b.roll = 0;
    const lift = mz > 0.3 && b.speed >= PLANE_TAKEOFF;
    b.pitch += ((lift ? 0.35 : 0) - b.pitch) * Math.min(1, (lift ? 2 : 6) * DT);
    b.yaw -= mx * 1.0 * clamp(b.speed / 15, 0, 1) * DT;
    const cp = Math.cos(b.pitch);
    b.x += -Math.sin(b.yaw) * cp * b.speed * DT;
    b.z += -Math.cos(b.yaw) * cp * b.speed * DT;
    b.y = Math.max(0, b.y + Math.sin(b.pitch) * b.speed * DT);
    setEuler(b);
  } else {
    let q = getQ(b);
    let { f, r } = planeAxes(b);
    const stalled = b.speed < PLANE_STALL;
    // Schub, dazu Schwerkraft entlang der Flugrichtung: Steigen bremst, Sturzflug beschleunigt
    b.speed += clamp(target - b.speed, -12 * DT, 18 * DT) - f[1] * 14 * DT;
    b.speed = clamp(b.speed, 0, PLANE_MAX * 1.45);
    // Rolle: kleiner Ausschlag = Schraeglage halten (Kurve), voller Ausschlag = Fassrolle
    let rollRate: number;
    if (Math.abs(mx) >= 0.7) rollRate = Math.sign(mx) * PLANE_ROLL_RATE * (0.35 + 0.65 * ((Math.abs(mx) - 0.7) / 0.3));
    else {
      // Ohne Nickeingabe richtet sich das Flugzeug auch aus dem Rueckenflug auf; waehrend eines Loopings
      // zaehlt nur die Querneigung der Fluegel, sonst wuerde die Rollhilfe den Looping stoeren.
      const bank = Math.abs(mz) < 0.1 ? b.roll : Math.asin(clamp(-r[1], -1, 1));
      rollRate = clamp(((mx / 0.7) * 1.0 - bank) * 3.5, -2.8, 2.8);
    }
    // Nick: Hoch = Nase hoch. Ohne Eingabe richtet sich die Nase langsam zum Horizont aus.
    const pitchRate = mz * PLANE_PITCH_RATE;
    q = qnorm(qmul(q, qaxis(0, 0, -1, rollRate * DT)));
    q = qnorm(qmul(q, qaxis(1, 0, 0, pitchRate * DT)));
    if (Math.abs(mz) < 0.1 && Math.abs(f[1]) < 0.995) {
      // Hilfe: um die waagerechte Achse quer zur Flugrichtung zum Horizont drehen
      // Achse = Kreuzprodukt(Y, f) = (f.z, 0, -f.x); positiver Winkel senkt die Nase
      q = qnorm(qmul(qaxis(f[2], 0, -f[0], f[1] * 0.9 * DT), q));
    }
    if (stalled) {
      // Ueberzogen: die Nase kippt nach unten
      const ax = f[2];
      const az = -f[0];
      if (Math.hypot(ax, az) > 1e-4) q = qnorm(qmul(qaxis(ax, 0, az, 1.3 * ((PLANE_STALL - b.speed) / PLANE_STALL) * DT), q));
    }
    putQ(b, q);
    ({ f, r } = planeAxes(b));
    // Kurve durch Schraeglage (Auftriebsvektor): ueber die Welt-y-Achse drehen
    const turn = 1.15 * r[1] * Math.sqrt(Math.max(0, 1 - f[1] * f[1]));
    putQ(b, qnorm(qmul(qaxis(0, 1, 0, turn * DT), getQ(b))));
    ({ f } = planeAxes(b));
    b.x += f[0] * b.speed * DT;
    b.z += f[2] * b.speed * DT;
    b.y += f[1] * b.speed * DT;
    if (stalled) b.y -= ((PLANE_STALL - b.speed) / PLANE_STALL) * 20 * DT;
    deriveAngles(b);
    if (b.y <= 0) {
      // Bodenberuehrung: sanft = aufsetzen, sonst Absturz
      const upsideDown = Math.cos(b.roll) < 0.2;
      if (b.pitch < -0.3 || (b.speed > 30 && b.pitch < -0.15) || upsideDown || Math.abs(b.roll) > 0.7) b.crash = true;
      b.y = 0;
      b.roll = 0;
      if (b.pitch < 0) b.pitch = 0;
      setEuler(b);
    }
    if (b.y > 250) {
      b.y = 250;
      if (f[1] > 0) {
        putQ(b, qnorm(qmul(qaxis(f[2], 0, -f[0], f[1] * 2 * DT), getQ(b))));
        deriveAngles(b);
      }
    }
  }
  for (const box of boxes) {
    if (b.y < box.h && Math.abs(b.x - box.x) < box.hw + 1.5 && Math.abs(b.z - box.z) < box.hd + 1.5) {
      b.crash = true;
      break;
    }
  }
}
