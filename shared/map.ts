// Die Karte wird aus einem Seed erzeugt, damit Server und Client exakt dieselben Gebaeude kennen.

export interface Box {
  x: number; // Mittelpunkt
  z: number;
  hw: number; // halbe Breite (x)
  hd: number; // halbe Tiefe (z)
  h: number; // Hoehe
}

export const WORLD = 480; // halbe Kantenlaenge der Spielwelt in Metern
export const CELL = 64;
// Flugplatz: freie Strasse entlang der x-Achse bei z = 0
export const RUNWAY = { x0: 70, x1: 450, z: 0, halfWidth: 12 };

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildMap(seed = 1337): Box[] {
  const r = mulberry32(seed);
  const out: Box[] = [];
  for (let i = -7; i <= 7; i++) {
    for (let j = -7; j <= 7; j++) {
      const cx = i * CELL;
      const cz = j * CELL;
      // Startplatz in der Mitte bleibt frei
      if (Math.abs(cx) < CELL * 0.9 && Math.abs(cz) < CELL * 0.9) continue;
      // Flugplatz-Strasse bleibt frei
      if (j === 0 && cx >= RUNWAY.x0 - CELL / 2 && cx <= RUNWAY.x1 + CELL / 2) continue;
      if (r() < 0.12) {
        r();
        r();
        r();
        r();
        r();
        continue; // Park
      }
      const w = 18 + r() * 16;
      const d = 18 + r() * 16;
      const h = 6 + r() * r() * 40 + (r() < 0.1 ? 30 : 0);
      out.push({ x: cx + (r() - 0.5) * 6, z: cz + (r() - 0.5) * 6, hw: w / 2, hd: d / 2, h });
    }
  }
  return out;
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
