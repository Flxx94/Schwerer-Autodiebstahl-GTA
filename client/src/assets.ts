// Laedt die Modelle (alles frei nutzbar, siehe README): KayKit (CC0), Kenney (MIT). Klappt etwas nicht,
// meldet loadAssets() null und das Spiel nutzt die einfachen Klotz-Modelle als Ersatz.
// Alle Groessen sind echte Meter: Figur 1,8 m, Auto 4,5 m, Hydrant 0,85 m, Strassenlaterne 7,5 m ...
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BUILDING_NAMES } from '../../shared/map';

export interface Prop {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export type PropName = 'hydrant' | 'trash' | 'bench' | 'dumpster' | 'boxA' | 'boxB' | 'tlA' | 'tlB' | 'tlC' | 'tower' | 'barrel' | 'pallet' | 'crate';

export interface Assets {
  buildings: Prop[]; // building_A..H (Massstab 1 = 2 x 2 m Grundflaeche, wird beim Platzieren skaliert)
  cars: THREE.Object3D[]; // fertig skalierte Vorlagen, Front zeigt nach -z
  streetlight: Prop; // in Metern
  bush: Prop; // in Metern
  props: Record<PropName, Prop>; // in Metern
  chars: { scene: THREE.Object3D; clips: THREE.AnimationClip[] }[];
}

const CAR_NAMES = ['car_sedan', 'car_taxi', 'car_police', 'car_hatchback', 'car_stationwagon'];
const TRUCKS = ['red', 'yellow', 'green', 'purple'];
// Soll-Laenge der Fahrzeuge in Metern (KayKit-Autos sind sehr kurz modelliert, deshalb pro Modell)
export const CAR_LENGTH = 4.5;
export const TRUCK_LENGTH = 5.2;
export const CHAR_HEIGHT = 1.8;

function firstMesh(root: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  if (!found) throw new Error('Modell ohne Mesh');
  return found;
}

// Lambert ist guenstiger als das Standard-Material und passt zur flachen Optik
function cheap(mat: THREE.Material): THREE.Material {
  const m = mat as THREE.MeshStandardMaterial;
  return new THREE.MeshLambertMaterial({ map: m.map ?? null, color: m.map ? 0xffffff : m.color });
}

// Skaliert die Geometrie auf eine Soll-Groesse in Metern ('h' = Hoehe, 'w' = groessere Seite am Boden)
function fit(p: Prop, target: number, dim: 'h' | 'w'): Prop {
  const g = p.geometry.clone();
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const size = dim === 'h' ? b.max.y - b.min.y : Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  const k = target / (size || 1);
  g.scale(k, k, k);
  g.translate(0, -b.min.y * k, 0);
  return { geometry: g, material: p.material };
}

export async function loadAssets(base = 'assets/'): Promise<Assets | null> {
  try {
    const loader = new GLTFLoader();
    const load = (p: string) => loader.loadAsync(base + p);
    const propFiles = ['city/firehydrant', 'city/trash_A', 'city/bench', 'city/dumpster', 'city/box_A', 'city/box_B', 'city/trafficlight_A', 'city/trafficlight_B', 'city/trafficlight_C', 'city/watertower', 'props/Barrel_A', 'props/Pallet_Small', 'props/Box_C'];

    const [bGltf, cGltf, tGltf, lamp, bush, rogue, hooded, pGltf] = await Promise.all([
      Promise.all(BUILDING_NAMES.map((n) => load(`city/building_${n}.gltf`))),
      Promise.all(CAR_NAMES.map((n) => load(`city/${n}.gltf`))),
      Promise.all(TRUCKS.map((n) => load(`vehicles/vehicle-truck-${n}.glb`))),
      load('city/streetlight.gltf'),
      load('city/bush.gltf'),
      load('chars/Rogue.glb'),
      load('chars/Rogue_Hooded.glb'),
      Promise.all(propFiles.map((n) => load(`${n}.gltf`))),
    ]);

    const toProp = (g: { scene: THREE.Group }): Prop => {
      const m = firstMesh(g.scene);
      return { geometry: m.geometry, material: cheap(m.material as THREE.Material) };
    };

    // Fahrzeuge: auf Soll-Laenge skalieren, auf den Boden setzen, Front nach -z
    const prepVehicle = (model: THREE.Object3D, length: number, flip: boolean) => {
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = cheap(mesh.material as THREE.Material);
      });
      const wrap = new THREE.Group();
      if (flip) model.rotation.y = Math.PI;
      wrap.add(model);
      const box = new THREE.Box3().setFromObject(wrap);
      const k = length / (box.max.z - box.min.z);
      wrap.scale.setScalar(k);
      wrap.position.y = -box.min.y * k;
      const outer = new THREE.Group();
      outer.add(wrap);
      // Reifenradius fuer die Drehung der Raeder
      outer.updateMatrixWorld(true);
      let wheel: THREE.Object3D | null = null;
      outer.traverse((o) => {
        if (!wheel && /wheel/i.test(o.name)) wheel = o;
      });
      if (wheel) {
        const wb = new THREE.Box3().setFromObject(wheel);
        outer.userData.wheelR = Math.max(0.2, (wb.max.y - wb.min.y) / 2);
      }
      return outer;
    };
    // KayKit-Autos schauen nach +z und sind im Modell nur 0,94 lang, aber 0,42 breit: auf 4,5 m Laenge
    // ergibt das eine Breite von 2,0 m, passend. Kenney-Pickups schauen auch nach +z.
    const cars = [...cGltf.map((g) => prepVehicle(g.scene, CAR_LENGTH, true)), ...tGltf.map((g) => prepVehicle(g.scene, TRUCK_LENGTH, true))];

    const chars = [rogue, hooded].map((g) => {
      const scene = g.scene;
      const box = new THREE.Box3().setFromObject(scene);
      const k = CHAR_HEIGHT / (box.max.y - box.min.y || 1);
      scene.scale.setScalar(k);
      scene.traverse((o) => {
        if (['Knife', 'Knife_Offhand', 'Throwable', '2H_Crossbow'].includes(o.name)) o.visible = false;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.frustumCulled = false; // Skinned Meshes: Huellkoerper stimmt in Animation nicht
      });
      return { scene, clips: g.animations };
    });

    const pr = pGltf.map(toProp);
    const props: Record<PropName, Prop> = {
      hydrant: fit(pr[0], 0.85, 'h'),
      trash: fit(pr[1], 0.5, 'w'),
      bench: fit(pr[2], 1.8, 'w'),
      dumpster: fit(pr[3], 2.2, 'w'),
      boxA: fit(pr[4], 0.8, 'h'),
      boxB: fit(pr[5], 0.6, 'h'),
      tlA: fit(pr[6], 5.0, 'h'),
      tlB: fit(pr[7], 5.4, 'h'),
      tlC: fit(pr[8], 6.0, 'h'),
      tower: fit(pr[9], 11, 'h'),
      barrel: fit(pr[10], 0.95, 'h'),
      pallet: fit(pr[11], 1.2, 'w'),
      crate: fit(pr[12], 1.0, 'h'),
    };
    return { buildings: bGltf.map(toProp), cars, streetlight: fit(toProp(lamp), 7.5, 'h'), bush: fit(toProp(bush), 1.3, 'h'), props, chars };
  } catch (e) {
    console.warn('Modelle konnten nicht geladen werden, nutze einfache Modelle', e);
    return null;
  }
}
