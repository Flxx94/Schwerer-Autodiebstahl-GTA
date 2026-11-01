// Alles, was mit Three.js gezeichnet wird: Karte, Spieler, Fahrzeuge, Effekte.
// Mit KayKit-Modellen (assets.ts); fehlen sie, gibt es einfache Klotz-Modelle als Ersatz.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { City, Box, WORLD, CELL, RUNWAY } from '../../shared/map';
import { Assets } from './assets';

export interface PlayerAnimState {
  speed: number; // m/s zu Fuss
  dead: boolean;
}

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setAssets(a: Assets | null): void;
  addMap(city: City): void;
  makePlayer(name: string, hue: number, id: number): THREE.Object3D;
  animatePlayer(o: THREE.Object3D, s: PlayerAnimState): void;
  playerFired(o: THREE.Object3D): void;
  disposeObject(o: THREE.Object3D): void;
  makeCar(hue: number, id: number): THREE.Object3D;
  spinWheels(o: THREE.Object3D, meters: number): void;
  makePlane(hue: number): THREE.Object3D;
  makeRocket(): THREE.Mesh;
  tracer(a: number[], b: number[]): void;
  boom(x: number, y: number, z: number, r: number): void;
  update(nowMs: number, dt: number): void;
  resize(): void;
}

const mat = (c: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color: c });
const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
};

interface PlayerAnim {
  mixer: THREE.AnimationMixer;
  idle: THREE.AnimationAction;
  run: THREE.AnimationAction;
  death: THREE.AnimationAction;
  shoot: THREE.AnimationAction;
  cur: THREE.AnimationAction;
  dead: boolean;
}

export function createWorld(canvas: HTMLCanvasElement): World {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x9fd0f0);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 170, 470);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.3, 520);
  scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6a6f60, 1.5));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(120, 260, 80);
  scene.add(sun);

  let assets: Assets | null = null;
  const mixers = new Set<THREE.AnimationMixer>();
  const effects: { obj: THREE.Object3D; until: number; start: number; kind: 'tracer' | 'boom'; r?: number }[] = [];

  // ---------------------------------------------------------------- Karte
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD * 2 + 400, WORLD * 2 + 400), mat(0x4b4f57));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  // Startplatz in der Mitte
  scene.add(box(104, 0.06, 104, mat(0x9a9da4), 0, 0.01, 0));

  function markings() {
    // gestrichelte Mittellinien auf allen Strassen, nicht auf Kreuzungen
    const dash = new THREE.BoxGeometry(0.5, 0.05, 4);
    const m = new THREE.MeshBasicMaterial({ color: 0xe8e2c0 });
    const pts: [number, number, number][] = [];
    for (let k = -8; k <= 7; k++) {
      const c = (k + 0.5) * CELL;
      for (let t = -WORLD; t <= WORLD; t += 10) {
        const nearCross = Math.abs(((t % CELL) + CELL) % CELL - CELL / 2) < 20;
        if (nearCross) continue;
        pts.push([c, t, 0]); // Strasse laeuft entlang z bei x = c
        pts.push([t, c, 1]); // Strasse laeuft entlang x bei z = c
      }
    }
    const inst = new THREE.InstancedMesh(dash, m, pts.length);
    const mx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    pts.forEach(([x, z, rot], i) => {
      mx.compose(new THREE.Vector3(x, 0.03, z), rot ? qy : q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, mx);
    });
    scene.add(inst);
    // Flugplatz-Strasse: breite weisse Streifen
    const paint = mat(0xf2f2f2);
    for (let x = RUNWAY.x0 + 10; x < RUNWAY.x1 - 10; x += 24) scene.add(box(10, 0.06, 0.8, paint, x, 0.06, RUNWAY.z));
  }

  function fallbackBuildings(boxes: Box[]) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), boxes.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, b.h / 2, b.z), new THREE.Quaternion(), new THREE.Vector3(b.hw * 2, b.h, b.hd * 2));
      inst.setMatrixAt(i, m);
      const palette = [0.08, 0.58, 0.02, 0.12, 0.95, 0.5];
      c.setHSL(palette[i % palette.length], 0.28 + ((i * 13) % 20) / 100, 0.52 + ((i * 29) % 30) / 100);
      inst.setColorAt(i, c);
    });
    scene.add(inst);
  }

  function addMap(city: City) {
    markings();
    // Parks
    const grass = mat(0x5f9a4a);
    for (const p of city.parks) scene.add(box(54, 0.05, 54, grass, p.x, 0.02, p.z));
    if (!assets) {
      fallbackBuildings(city.boxes);
      return;
    }
    // Gebaeude: eine InstancedMesh pro Modell und Kachel (3 x 3 Bloecke). So zeichnet die Grafikkarte
    // nur die Kacheln, die im Bild liegen, und die Draw Calls bleiben niedrig.
    const mx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const TILE = CELL * 3;
    const groups = new Map<string, Box[]>();
    for (const b of city.boxes) {
      const key = `${b.k}|${Math.floor(b.x / TILE)}|${Math.floor(b.z / TILE)}`;
      const g = groups.get(key);
      if (g) g.push(b);
      else groups.set(key, [b]);
    }
    for (const [key, list] of groups) {
      const prop = assets.buildings[Number(key.split('|')[0])];
      const inst = new THREE.InstancedMesh(prop.geometry, prop.material, list.length);
      list.forEach((b, i) => {
        q.setFromAxisAngle(up, (b.rot * Math.PI) / 2);
        mx.compose(new THREE.Vector3(b.x, 0, b.z), q, new THREE.Vector3(b.s, b.s, b.s));
        inst.setMatrixAt(i, mx);
      });
      inst.computeBoundingSphere();
      scene.add(inst);
    }
    // Strassenlaternen: eine pro Kreuzung, Arm zeigt zur Kreuzungsmitte
    const lamps: THREE.Matrix4[] = [];
    for (let i = -8; i <= 7; i++) {
      for (let j = -8; j <= 7; j++) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        if (Math.abs(cx) < 60 && Math.abs(cz) < 60) continue;
        q.setFromAxisAngle(up, -Math.PI / 4);
        lamps.push(new THREE.Matrix4().compose(new THREE.Vector3(cx + 17, 0, cz + 17), q.clone(), new THREE.Vector3(9, 9, 9)));
      }
    }
    const lampMesh = new THREE.InstancedMesh(assets.streetlight.geometry, assets.streetlight.material, lamps.length);
    lamps.forEach((m, i) => lampMesh.setMatrixAt(i, m));
    scene.add(lampMesh);
    // Buesche in den Parks
    const bushes: THREE.Matrix4[] = [];
    for (const p of city.parks) {
      for (let n = 0; n < 12; n++) {
        const a = n * 2.4;
        const d = 5 + (n % 5) * 4.5;
        const s = 7 + (n % 3) * 2;
        q.setFromAxisAngle(up, n);
        bushes.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x + Math.cos(a) * d, 0, p.z + Math.sin(a) * d), q.clone(), new THREE.Vector3(s, s, s)));
      }
    }
    if (bushes.length) {
      const bm = new THREE.InstancedMesh(assets.bush.geometry, assets.bush.material, bushes.length);
      bushes.forEach((m, i) => bm.setMatrixAt(i, m));
      scene.add(bm);
    }
  }

  // ---------------------------------------------------------------- Namensschild
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

  // ---------------------------------------------------------------- Spieler
  function simplePlayer(hue: number) {
    const g = new THREE.Group();
    const col = new THREE.Color().setHSL(hue / 360, 0.65, 0.5);
    g.add(box(0.8, 1.1, 0.5, mat(col), 0, 0.85, 0));
    g.add(box(0.6, 0.6, 0.6, mat(0xf0c8a0), 0, 1.7, 0));
    g.add(box(0.7, 0.55, 0.45, mat(0x222a33), 0, 0.28, 0));
    g.add(box(0.12, 0.12, 0.7, mat(0x111111), 0.35, 1.0, -0.5));
    return g;
  }

  function makePlayer(name: string, hue: number, id: number) {
    const root = new THREE.Group();
    // farbiger Ring unter den Fuessen, damit man Mitspieler auch von weitem auseinanderhaelt
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 20),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue / 360, 0.8, 0.55), side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    root.add(ring);
    const a = assets?.chars[id % assets.chars.length];
    if (a) {
      const model = cloneSkinned(a.scene);
      model.rotation.y = Math.PI; // KayKit-Figuren schauen nach +z, wir nach -z
      const holder = new THREE.Group();
      holder.add(model);
      root.add(holder);
      const mixer = new THREE.AnimationMixer(model);
      mixers.add(mixer);
      const get = (n: string) => {
        const clip = THREE.AnimationClip.findByName(a.clips, n);
        return mixer.clipAction(clip ?? a.clips[0]);
      };
      const idle = get('Idle');
      const run = get('Running_A');
      const death = get('Death_A');
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
      const shoot = get('1H_Ranged_Shooting');
      shoot.setLoop(THREE.LoopOnce, 1);
      idle.play();
      root.userData.anim = { mixer, idle, run, death, shoot, cur: idle, dead: false } as PlayerAnim;
    } else {
      root.add(simplePlayer(hue));
    }
    if (name) root.add(label(name));
    return root;
  }

  function animatePlayer(o: THREE.Object3D, s: PlayerAnimState) {
    const an = o.userData.anim as PlayerAnim | undefined;
    if (!an) return;
    const want = s.dead ? an.death : s.speed > 0.8 ? an.run : an.idle;
    if (s.dead !== an.dead) {
      an.dead = s.dead;
      if (!s.dead) an.death.stop();
    }
    if (want !== an.cur) {
      an.cur.fadeOut(0.15);
      want.reset().fadeIn(0.15).play();
      an.cur = want;
    }
    if (want === an.run) an.run.timeScale = Math.min(1.5, Math.max(0.7, s.speed / 6));
  }

  function playerFired(o: THREE.Object3D) {
    const an = o.userData.anim as PlayerAnim | undefined;
    if (!an || an.dead) return;
    an.shoot.reset().fadeIn(0.05).play();
  }

  function disposeObject(o: THREE.Object3D) {
    const an = o.userData.anim as PlayerAnim | undefined;
    if (an) {
      an.mixer.stopAllAction();
      mixers.delete(an.mixer);
    }
  }

  // ---------------------------------------------------------------- Fahrzeuge
  function makeCar(hue: number, id: number) {
    if (assets) {
      const car = assets.cars[id % assets.cars.length].clone(true);
      car.userData.wheels = [] as THREE.Object3D[];
      car.traverse((o) => {
        if (o.name.includes('_wheel_')) car.userData.wheels.push(o);
      });
      return car;
    }
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

  function spinWheels(o: THREE.Object3D, meters: number) {
    const ws = o.userData.wheels as THREE.Object3D[] | undefined;
    if (!ws) return;
    for (const w of ws) w.rotation.x -= meters / 0.35; // KayKit-Reifenradius ca. 0,35 m nach Skalierung
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
    g.add(box(0.15, 2.2, 0.15, mat(0x333333), 0, 1.4, -3.7)); // Propellerblatt
    return g;
  }

  function makeRocket() {
    return new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 1.0), new THREE.MeshBasicMaterial({ color: 0xff6a00 }));
  }

  // ---------------------------------------------------------------- Effekte
  function tracer(a: number[], b: number[]) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], a[1] - 0.2, a[2]), new THREE.Vector3(b[0], b[1], b[2])]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a }));
    scene.add(line);
    const t = performance.now();
    effects.push({ obj: line, until: t + 90, start: t, kind: 'tracer' });
  }

  function boom(x: number, y: number, z: number, r: number) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0.85 }));
    s.position.set(x, y, z);
    scene.add(s);
    const t = performance.now();
    effects.push({ obj: s, until: t + 600, start: t, kind: 'boom', r });
  }

  function update(nowMs: number, dt: number) {
    for (const m of mixers) m.update(dt);
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (nowMs >= e.until) {
        scene.remove(e.obj);
        (e.obj as THREE.Mesh).geometry?.dispose();
        effects.splice(i, 1);
      } else if (e.kind === 'boom') {
        const k = (nowMs - e.start) / (e.until - e.start);
        e.obj.scale.setScalar((e.r ?? 6) * (0.3 + k * 0.9));
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

  return {
    renderer,
    scene,
    camera,
    setAssets: (a) => {
      assets = a;
    },
    addMap,
    makePlayer,
    animatePlayer,
    playerFired,
    disposeObject,
    makeCar,
    spinWheels,
    makePlane,
    makeRocket,
    tracer,
    boom,
    update,
    resize,
  };
}
