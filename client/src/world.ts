// Alles, was mit Three.js gezeichnet wird: Karte, Spieler, Fahrzeuge, Effekte, Kamera.
import * as THREE from 'three';
import { Box, WORLD, RUNWAY } from '../../shared/map';

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  addMap(boxes: Box[]): void;
  makePlayer(name: string, hue: number): THREE.Group;
  makeCar(hue: number): THREE.Group;
  makePlane(hue: number): THREE.Group;
  makeRocket(): THREE.Mesh;
  tracer(a: number[], b: number[]): void;
  boom(x: number, y: number, z: number, r: number): void;
  updateFx(nowMs: number): void;
  resize(): void;
}

const mat = (c: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color: c });
const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
};

export function createWorld(canvas: HTMLCanvasElement): World {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x8fc4e8);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 180, 520);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.3, 700);
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x56604a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
  sun.position.set(120, 260, 80);
  scene.add(sun);

  // Boden und Flugplatz-Strasse
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD * 2 + 200, WORLD * 2 + 200), mat(0x6f8f5a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  const asphalt = mat(0x3b3f45);
  const road = box(RUNWAY.x1 - RUNWAY.x0, 0.05, RUNWAY.halfWidth * 2, asphalt, (RUNWAY.x0 + RUNWAY.x1) / 2, 0.01, RUNWAY.z);
  scene.add(road);
  const paint = mat(0xeeeeee);
  for (let x = RUNWAY.x0 + 10; x < RUNWAY.x1 - 10; x += 24) scene.add(box(10, 0.06, 0.8, paint, x, 0.05, RUNWAY.z));
  // Startplatz in der Mitte
  scene.add(box(120, 0.05, 120, mat(0x8a8d93), 0, 0.01, 0));

  const effects: { obj: THREE.Object3D; until: number; start: number; kind: 'tracer' | 'boom'; r?: number }[] = [];

  function addMap(boxes: Box[]) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), boxes.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, b.h / 2, b.z), new THREE.Quaternion(), new THREE.Vector3(b.hw * 2, b.h, b.hd * 2));
      inst.setMatrixAt(i, m);
      const palette = [0.08, 0.58, 0.02, 0.12, 0.95, 0.5];
      c.setHSL(palette[i % palette.length], 0.28 + ((i * 13) % 20) / 100, 0.52 + ((i * 29) % 30) / 100);
      inst.setColorAt(i, c);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
  }

  function label(name: string): THREE.Sprite {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 64;
    const g = cv.getContext('2d')!;
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,.8)';
    g.strokeText(name, 128, 42);
    g.fillStyle = '#fff';
    g.fillText(name, 128, 42);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.set(2.6, 0.65, 1);
    sp.position.y = 2.5;
    sp.renderOrder = 10;
    return sp;
  }

  function makePlayer(name: string, hue: number) {
    const g = new THREE.Group();
    const col = new THREE.Color().setHSL(hue / 360, 0.65, 0.5);
    g.add(box(0.8, 1.1, 0.5, mat(col), 0, 0.85, 0));
    g.add(box(0.6, 0.6, 0.6, mat(0xf0c8a0), 0, 1.7, 0));
    g.add(box(0.7, 0.55, 0.45, mat(0x222a33), 0, 0.28, 0));
    g.add(box(0.12, 0.12, 0.7, mat(0x111111), 0.35, 1.0, -0.5));
    g.add(label(name));
    return g;
  }

  function makeCar(hue: number) {
    const g = new THREE.Group();
    const col = new THREE.Color().setHSL(hue / 360, 0.7, 0.5);
    g.add(box(2.0, 0.8, 4.4, mat(col), 0, 0.75, 0));
    g.add(box(1.7, 0.7, 2.1, mat(0x9fc8e0), 0, 1.45, 0.3));
    const wheel = mat(0x151515);
    for (const [x, z] of [
      [-1.0, -1.4],
      [1.0, -1.4],
      [-1.0, 1.4],
      [1.0, 1.4],
    ]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 10), wheel);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.45, z);
      g.add(w);
    }
    return g;
  }

  function makePlane(hue: number) {
    const g = new THREE.Group();
    const col = new THREE.Color().setHSL(hue / 360, 0.6, 0.55);
    const white = mat(0xf2f2f2);
    g.add(box(1.2, 1.2, 7.2, white, 0, 1.4, 0));
    g.add(box(11, 0.18, 1.9, mat(col), 0, 1.5, -0.4));
    g.add(box(0.16, 1.6, 1.3, mat(col), 0, 2.2, 3.1));
    g.add(box(3.8, 0.14, 1.0, mat(col), 0, 1.6, 3.1));
    g.add(box(0.9, 0.6, 1.2, mat(0x9fc8e0), 0, 2.1, -1.2));
    g.add(box(0.3, 0.9, 0.3, mat(0x222222), -0.9, 0.55, -1.0));
    g.add(box(0.3, 0.9, 0.3, mat(0x222222), 0.9, 0.55, -1.0));
    return g;
  }

  function makeRocket() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 1.0), new THREE.MeshBasicMaterial({ color: 0xff6a00 }));
    return m;
  }

  function tracer(a: number[], b: number[]) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], a[1] - 0.2, a[2]), new THREE.Vector3(b[0], b[1], b[2])]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a }));
    scene.add(line);
    const t = performance.now();
    effects.push({ obj: line, until: t + 90, start: t, kind: 'tracer' });
  }

  function boom(x: number, y: number, z: number, r: number) {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0.85 }),
    );
    s.position.set(x, y, z);
    scene.add(s);
    const t = performance.now();
    effects.push({ obj: s, until: t + 600, start: t, kind: 'boom', r });
  }

  function updateFx(nowMs: number) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (nowMs >= e.until) {
        scene.remove(e.obj);
        const o = e.obj as THREE.Mesh;
        o.geometry?.dispose();
        effects.splice(i, 1);
      } else if (e.kind === 'boom') {
        const k = (nowMs - e.start) / (e.until - e.start);
        const s = (e.r ?? 6) * (0.3 + k * 0.9);
        e.obj.scale.setScalar(s);
        ((e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      }
    }
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, addMap, makePlayer, makeCar, makePlane, makeRocket, tracer, boom, updateFx, resize };
}
