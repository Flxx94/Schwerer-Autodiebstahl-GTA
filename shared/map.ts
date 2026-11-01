// Die Karte wird aus einem Seed erzeugt, damit Server und Client exakt dieselben Gebaeude kennen.
// Gebaeude sind KayKit-"City Builder Bits" (CC0). Der Server braucht nur die Kollisionsboxen.

export interface Box {
  x: number; // Mittelpunkt
  z: number;
  hw: number; // halbe Breite (x)
  hd: number; // halbe Tiefe (z)
  h: number; // Hoehe
  k: number; // Gebaeudetyp 0..7 (building_A bis building_H), nur fuer die Darstellung
  rot: number; // Drehung in Viertelkreisen, nur fuer die Darstellung
  s: number; // Massstab des Modells, nur fuer die Darstellung
}

export const WORLD = 480; // halbe Kantenlaenge der Spielwelt in Metern
export const CELL = 64;
// Flugplatz: freie Strasse entlang der x-Achse bei z = 0
export const RUNWAY = { x0: 70, x1: 450, z: 0, halfWidth: 12 };

// Hoehe der Modelle building_A..H bei Massstab 1 (Grundflaeche 2 x 2)
export const BUILDING_H = [1.65, 1.65, 2.98, 2.97, 2.35, 2.35, 2.98, 3.05];
export const BUILDING_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface City {
  boxes: Box[];
  parks: { x: number; z: number }[];
}

export function buildCity(seed = 1337): City {
  const r = mulberry32(seed);
  const boxes: Box[] = [];
  const parks: { x: number; z: number }[] = [];
  for (let i = -7; i <= 7; i++) {
    for (let j = -7; j <= 7; j++) {
      const cx = i * CELL;
      const cz = j * CELL;
      // Startplatz in der Mitte bleibt frei
      if (Math.abs(cx) < CELL * 0.9 && Math.abs(cz) < CELL * 0.9) continue;
      // Flugplatz-Strasse bleibt frei
      if (j === 0 && cx >= RUNWAY.x0 - CELL / 2 && cx <= RUNWAY.x1 + CELL / 2) continue;
      if (r() < 0.12) {
        parks.push({ x: cx, z: cz });
        continue;
      }
      const k = Math.floor(r() * 8);
      const s = 12 + r() * 3;
      const rot = Math.floor(r() * 4);
      const half = 0.86 * s; // Kollisionsbox etwas kleiner als der Gehweg-Sockel
      boxes.push({
        x: cx + (r() - 0.5) * 4,
        z: cz + (r() - 0.5) * 4,
        hw: half,
        hd: half,
        h: BUILDING_H[k] * s,
        k,
        rot,
        s,
      });
    }
  }
  return { boxes, parks };
}

export function buildMap(seed = 1337): Box[] {
  return buildCity(seed).boxes;
}

// Abstand von einem Punkt (x,z) zum naechsten Gebaeude (0, wenn innen)
export function distToBoxes(boxes: Box[], x: number, z: number): number {
  let best = Infinity;
  for (const b of boxes) {
    const dx = Math.max(Math.abs(x - b.x) - b.hw, 0);
    const dz = Math.max(Math.abs(z - b.z) - b.hd, 0);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}
