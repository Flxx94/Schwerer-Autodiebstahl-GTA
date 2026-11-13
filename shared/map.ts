// Die Karte wird aus einem Seed erzeugt, damit Server und Client exakt dieselben Gebaeude kennen.
// Gebaeude sind KayKit-"City Builder Bits" (CC0). Der Server braucht nur die Kollisionsboxen.

export interface Box {
  x: number; // Mittelpunkt der Kollisionsbox
  z: number;
  hw: number; // halbe Breite (x)
  hd: number; // halbe Tiefe (z)
  h: number; // Hoehe
  k: number; // Gebaeudetyp 0..7 (building_A bis building_H), nur fuer die Darstellung
  rot: number; // Drehung in Viertelkreisen, nur fuer die Darstellung
  s: number; // Massstab des Modells, nur fuer die Darstellung
  px: number; // Ursprung des Modells (fuer die Darstellung)
  pz: number;
}

export const WORLD = 130; // halbe Kantenlaenge der Arena in Metern (260 x 260 m)
export const CELL = 52; // Abstand der Bloecke; dazwischen liegen 24 m breite Strassen
export const PITCH = 14; // Abstand der vier Gebaeude innerhalb eines Blocks

// Hoehe der Modelle building_A..H bei Massstab 1 (Grundflaeche 2 x 2). Mit Massstab ca. 6
// hat ein Stockwerk etwa 3,3 m, also normale Tueren und Fenster neben einer 1,8 m grossen Figur.
export const BUILDING_H = [1.65, 1.65, 2.98, 2.97, 2.35, 2.35, 2.98, 3.05];
export const BUILDING_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
// Grundriss des Gebaeudekoerpers ohne Sockel (x0, x1, z0, z1) bei Massstab 1, gemessen am Modell.
// Damit stimmen Kollision und Schuesse mit dem ueberein, was man sieht.
const BODY: [number, number, number, number][] = [
  [-0.94, 0.9, -0.65, 0.9],
  [-0.8, 0.9, -0.98, 0.9],
  [-0.79, 0.6, -0.65, 0.7],
  [-0.8, 0.8, -0.65, 1.02],
  [-1, 1, -0.98, 0.9],
  [-1, 1, -0.65, 0.8],
  [-1, 1, -0.98, 0.97],
  [-1, 1, -0.98, 0.98],
];

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
  parks: { x: number; z: number }[]; // ganze Bloecke als Park
}

export const BLOCKS = 2; // Bloecke von -2 bis 2 in beiden Richtungen: 5 x 5 Bloecke

export function buildCity(seed = 1337): City {
  const r = mulberry32(seed);
  const boxes: Box[] = [];
  const parks: { x: number; z: number }[] = [];
  for (let i = -BLOCKS; i <= BLOCKS; i++) {
    for (let j = -BLOCKS; j <= BLOCKS; j++) {
      const cx = i * CELL;
      const cz = j * CELL;
      // Der Platz in der Mitte bleibt frei (dort liegt der Raketenwerfer)
      if (i === 0 && j === 0) continue;
      if (r() < 0.1) {
        parks.push({ x: cx, z: cz });
        continue;
      }
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          if (r() < 0.1) continue; // Luecke im Block
          const k = Math.floor(r() * 8);
          const s = 5.8 + r() * 1.0;
          const rot = Math.floor(r() * 4);
          const ox = cx + (sx * PITCH) / 2 + (r() - 0.5);
          const oz = cz + (sz * PITCH) / 2 + (r() - 0.5);
          const [x0, x1, z0, z1] = BODY[k];
          // Koerper-Grundriss mit Drehung (Viertelkreise um die y-Achse)
          let bx: [number, number], bz: [number, number];
          if (rot === 0) (bx = [x0, x1]), (bz = [z0, z1]);
          else if (rot === 1) (bx = [z0, z1]), (bz = [-x1, -x0]);
          else if (rot === 2) (bx = [-x1, -x0]), (bz = [-z1, -z0]);
          else (bx = [-z1, -z0]), (bz = [x0, x1]);
          boxes.push({
            x: ox + ((bx[0] + bx[1]) / 2) * s,
            z: oz + ((bz[0] + bz[1]) / 2) * s,
            hw: ((bx[1] - bx[0]) / 2) * s,
            hd: ((bz[1] - bz[0]) / 2) * s,
            h: BUILDING_H[k] * s,
            k,
            rot,
            s,
            px: ox,
            pz: oz,
          });
        }
      }
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

// Aufsammelbare Gegenstaende auf festen Plaetzen (Strassenkreuzungen und Platz in der Mitte).
// kind: 0 Medikit, 1 Sturmgewehr, 2 Raketenwerfer
export interface Pickup {
  x: number;
  z: number;
  kind: 0 | 1 | 2;
  respawn: number; // Sekunden bis der Gegenstand wieder da ist
}
export const PICKUPS: Pickup[] = [
  { x: 0, z: 0, kind: 2, respawn: 45 },
  { x: 78, z: -78, kind: 2, respawn: 45 },
  { x: -78, z: 78, kind: 2, respawn: 45 },
  ...[
    [26, 26],
    [-26, 26],
    [26, -26],
    [-26, -26],
  ].map(([x, z]) => ({ x, z, kind: 1 as const, respawn: 25 })),
  ...[
    [78, 0],
    [-78, 0],
    [0, 78],
    [0, -78],
    [78, 78],
    [-78, -78],
  ].map(([x, z]) => ({ x, z, kind: 0 as const, respawn: 20 })),
];
