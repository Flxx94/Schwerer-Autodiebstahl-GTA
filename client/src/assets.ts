// Laedt die KayKit-Modelle (CC0, https://kaylousberg.itch.io). Klappt etwas nicht,
// meldet loadAssets() null und das Spiel nutzt die einfachen Klotz-Modelle als Ersatz.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BUILDING_NAMES } from '../../shared/map';

export interface Prop {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface Assets {
  buildings: Prop[]; // building_A..H
  cars: THREE.Object3D[]; // fertig skalierte Vorlagen (Laenge ca. 4,6 m, Front zeigt nach -z)
  streetlight: Prop;
  bush: Prop;
  chars: { scene: THREE.Object3D; clips: THREE.AnimationClip[] }[];
}

const CAR_NAMES = ['car_sedan', 'car_taxi', 'car_police', 'car_hatchback', 'car_stationwagon'];
export const CAR_LENGTH = 4.6;
export const CHAR_HEIGHT = 1.9;

function firstMesh(root: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  if (!found) throw new Error('Modell ohne Mesh');
  return found;
}

// Lambert ist guenstiger als das Standard-Material und passt zur flachen KayKit-Optik
function cheap(mat: THREE.Material): THREE.Material {
  const m = mat as THREE.MeshStandardMaterial;
  return new THREE.MeshLambertMaterial({ map: m.map ?? null, color: m.map ? 0xffffff : m.color });
}

export async function loadAssets(base = 'assets/'): Promise<Assets | null> {
  try {
    const loader = new GLTFLoader();
    const load = (p: string) => loader.loadAsync(base + p);

    const [bGltf, cGltf, lamp, bush, rogue, hooded] = await Promise.all([
      Promise.all(BUILDING_NAMES.map((n) => load(`city/building_${n}.gltf`))),
      Promise.all(CAR_NAMES.map((n) => load(`city/${n}.gltf`))),
      load('city/streetlight.gltf'),
      load('city/bush.gltf'),
      load('chars/Rogue.glb'),
      load('chars/Rogue_Hooded.glb'),
    ]);

    const toProp = (g: { scene: THREE.Group }): Prop => {
      const m = firstMesh(g.scene);
      return { geometry: m.geometry, material: cheap(m.material as THREE.Material) };
    };

    const cars = cGltf.map((g) => {
      const model = g.scene;
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = cheap(mesh.material as THREE.Material);
      });
      const wrap = new THREE.Group();
      model.rotation.y = Math.PI; // KayKit-Fahrzeuge schauen nach +z, wir fahren nach -z
      wrap.add(model);
      const box = new THREE.Box3().setFromObject(wrap);
      const k = CAR_LENGTH / (box.max.z - box.min.z);
      wrap.scale.setScalar(k);
      wrap.position.y = -box.min.y * k;
      const outer = new THREE.Group();
      outer.add(wrap);
      return outer;
    });

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

    return { buildings: bGltf.map(toProp), cars, streetlight: toProp(lamp), bush: toProp(bush), chars };
  } catch (e) {
    console.warn('KayKit-Assets konnten nicht geladen werden, nutze einfache Modelle', e);
    return null;
  }
}
