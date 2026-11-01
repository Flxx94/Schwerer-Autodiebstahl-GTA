// Alles, was mit Three.js gezeichnet wird: Karte, Spieler, Fahrzeuge, Effekte.
// Mit KayKit-Modellen (assets.ts); fehlen sie, gibt es einfache Klotz-Modelle als Ersatz.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { City, Box, WORLD, CELL, RUNWAY } from '../../shared/map';
import { Assets } from './assets';

export interface PlayerAnimState {
  vx: number; // Geschwindigkeit in der Welt (m/s)
  vz: number;
  yaw: number; // Blickrichtung (Zielrichtung)
  dead: boolean;
  dt: number;
}

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setAssets(a: Assets | null): void;
  addMap(city: City): void;
  makePlayer(name: string, hue: number, id: number): THREE.Object3D;
  animatePlayer(o: THREE.Object3D, s: PlayerAnimState): void;
  focus(x: number, y: number, z: number): void;
  dust(x: number, z: number, speed: number): void;
  info(): { quality: string; fps: number };
  playerFired(o: THREE.Object3D): void;
  disposeObject(o: THREE.Object3D): void;
  makeCar(hue: number, id: number): THREE.Object3D;
  spinWheels(o: THREE.Object3D, meters: number): void;
  makePlane(hue: number): THREE.Object3D;
  makeRocket(): THREE.Mesh;
  tracer(a: number[], b: number[], hit?: number, wl?: number): void;
  vehicleFx(o: THREE.Object3D, kind: number, hpRatio: number, burning: boolean, dt: number): void;
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
  holder: THREE.Group;
  flash: THREE.Sprite;
  // Fuer jede Fortbewegungsart: Beine (ganzer Koerper ohne Oberkoerper) und Oberkoerper getrennt,
  // damit der Oberkoerper beim Schiessen zielen kann, waehrend die Beine weiterlaufen.
  lower: THREE.AnimationAction[];
  upper: THREE.AnimationAction[];
  aim: THREE.AnimationAction;
  death: THREE.AnimationAction;
  w: number[]; // geglaettete Gewichte: Idle, Vor, Links, Rechts, Zurueck
  aimW: number;
  deadW: number;
  dead: boolean;
  yaw: number;
  fireUntil: number;
  flashUntil: number;
}

// Knochen des Oberkoerpers (Namen so, wie der GLTF-Loader sie nach dem Bereinigen nennt)
const UPPER = new Set(['spine', 'chest', 'head', 'upperarml', 'upperarmr', 'lowerarml', 'lowerarmr', 'wristl', 'wristr', 'handl', 'handr', 'handslotl', 'handslotr']);
const trackBone = (t: THREE.KeyframeTrack) => t.name.slice(0, t.name.lastIndexOf('.'));
function splitClip(clip: THREE.AnimationClip) {
  const up = clip.tracks.filter((t) => UPPER.has(trackBone(t)));
  const lo = clip.tracks.filter((t) => !UPPER.has(trackBone(t)));
  return {
    lower: new THREE.AnimationClip(clip.name + '_lo', clip.duration, lo),
    upper: new THREE.AnimationClip(clip.name + '_up', clip.duration, up),
  };
}

// Kleines Partikelsystem (Funken, Rauch, Feuer): ein Draw Call, Bewegung auf der CPU.
class Particles {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private siz: Float32Array;
  private vel: Float32Array;
  private par: Float32Array; // pro Partikel: Alter, Lebensdauer, Start-Groesse, End-Groesse, Start-Alpha, Gravitation, Bremse
  private next = 0;
  private posA: THREE.BufferAttribute;
  private colA: THREE.BufferAttribute;
  private sizA: THREE.BufferAttribute;
  constructor(scene: THREE.Scene, n: number, additive: boolean, uScale: { value: number }) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.siz = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.par = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) this.par[i * 7 + 1] = 0; // Lebensdauer 0 = frei
    const g = new THREE.BufferGeometry();
    this.posA = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colA = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizA = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posA);
    g.setAttribute('aColor', this.colA);
    g.setAttribute('aSize', this.sizA);
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = min(aSize * uScale / max(0.2, -mv.z), 220.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC;
        void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, r); a *= a;
          gl_FragColor = vec4(vC.rgb, vC.a * a); }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, grav = 0, drag = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b, a], i * 4);
    this.par.set([0, life, s0, s1, a, grav, drag], i * 7);
    this.siz[i] = s0;
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      const p = i * 7;
      const life = this.par[p + 1];
      if (life <= 0) continue;
      const age = (this.par[p] += dt);
      if (age >= life) {
        this.par[p + 1] = 0;
        this.siz[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      const k = age / life;
      const drag = Math.exp(-this.par[p + 6] * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + this.par[p + 5] * dt;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.05, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.siz[i] = this.par[p + 2] + (this.par[p + 3] - this.par[p + 2]) * k;
      this.col[i * 4 + 3] = this.par[p + 4] * (1 - k) * (1 - k * 0.3);
    }
    this.posA.needsUpdate = true;
    this.colA.needsUpdate = true;
    this.sizA.needsUpdate = true;
  }
}

const rnd = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,140,.9)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function asphaltTexture() {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#4a4e56';
  g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N);
  for (let i = 0; i < N * N; i++) {
    const v = (Math.random() - 0.5) * 26 + (Math.random() < 0.02 ? 14 : 0);
    img.data[i * 4] += v;
    img.data[i * 4 + 1] += v;
    img.data[i * 4 + 2] += v * 1.05;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createWorld(canvas: HTMLCanvasElement): World {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  // Qualitaet: ?q=high / ?q=low erzwingt eine Stufe, sonst schaltet das Spiel bei zu wenigen Bildern pro Sekunde selbst herunter
  const qParam = new URLSearchParams(location.search).get('q');
  const auto = qParam !== 'high' && qParam !== 'low';
  let quality: 'high' | 'low' = qParam === 'low' ? 'low' : 'high';
  const pixelRatio = () => (quality === 'high' ? Math.min(window.devicePixelRatio || 1, 1.5) : 1);
  renderer.setPixelRatio(pixelRatio());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const SKY_TOP = new THREE.Color(0x3f86d8);
  const SKY_HOR = new THREE.Color(0xcfe3f2);
  scene.fog = new THREE.Fog(SKY_HOR.clone(), 90, 270);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 300);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x727565, 1.1));
  const SUN_DIR = new THREE.Vector3(0.42, 0.78, 0.3).normalize();
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
  sun.castShadow = quality === 'high';
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -46;
  sc.right = sc.top = 46;
  sc.near = 10;
  sc.far = 420;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  scene.add(sun, sun.target);

  // ---------------------------------------------------------------- Himmel (Shader: Verlauf, Sonne, Wolken)
  const skyUniforms = {
    uTop: { value: SKY_TOP },
    uHor: { value: SKY_HOR },
    uSun: { value: SUN_DIR },
    uTime: { value: 0 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1.,0.)), f.x), mix(h(i+vec2(0.,1.)), h(i+vec2(1.,1.)), f.x), f.y); }
      void main(){
        vec3 d = normalize(vDir);
        float y = max(d.y, 0.0);
        vec3 col = mix(uHor, uTop, pow(y, 0.5));
        float sd = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.82, 0.55) * (pow(sd, 900.0) * 6.0 + pow(sd, 14.0) * 0.35);
        if (d.y > 0.01) {
          vec2 uv = d.xz / (d.y + 0.18) * 1.5 + vec2(uTime * 0.012, uTime * 0.004);
          float c = n(uv) * 0.55 + n(uv * 2.13) * 0.3 + n(uv * 4.7) * 0.15;
          c = smoothstep(0.52, 0.82, c) * smoothstep(0.01, 0.22, d.y);
          col = mix(col, vec3(1.0, 0.99, 0.97) * (0.85 + 0.2 * sd), c * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 12), skyMat);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = 1000;
  scene.add(skyDome);

  let assets: Assets | null = null;
  const mixers = new Set<THREE.AnimationMixer>();
  const spinners = new Set<THREE.Object3D>();
  const timers: { at: number; fn: () => void }[] = [];
  const effects: { obj: THREE.Object3D; until: number; start: number; kind: 'tracer' | 'boom' | 'ring' | 'flash'; r?: number; a?: THREE.Vector3; b?: THREE.Vector3; len?: number }[] = [];

  const uScale = { value: 800 };
  const fire = new Particles(scene, 500, true, uScale);
  const smoke = new Particles(scene, 400, false, uScale);
  const glow = glowTexture();

  // ---------------------------------------------------------------- Karte
  const groundTex = asphaltTexture();
  const gsize = WORLD * 2 + 400;
  groundTex.repeat.set(gsize / 10, gsize / 10);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(gsize, gsize), new THREE.MeshLambertMaterial({ map: groundTex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
  // Startplatz in der Mitte
  const plaza = box(76, 0.06, 76, mat(0x9a9da4), 0, 0.01, 0);
  plaza.receiveShadow = true;
  scene.add(plaza);

  function markings() {
    // gestrichelte Mittellinien auf allen Strassen, nicht auf Kreuzungen
    const dash = new THREE.BoxGeometry(0.5, 0.05, 4);
    const m = new THREE.MeshBasicMaterial({ color: 0xe8e2c0 });
    const pts: [number, number, number][] = [];
    for (let k = -9; k <= 8; k++) {
      const c = (k + 0.5) * CELL;
      for (let t = -WORLD; t <= WORLD; t += 10) {
        const nearCross = Math.abs(((t % CELL) + CELL) % CELL - CELL / 2) < 15.5;
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
    inst.castShadow = inst.receiveShadow = true;
    scene.add(inst);
  }

  // Viele gleiche Modelle als InstancedMesh, nach Kacheln getrennt (2 x 2 Bloecke), damit die Grafikkarte
  // nur zeichnet, was in der Naehe der Kamera liegt (Frustum-Culling arbeitet pro Kachel).
  function instanced(prop: { geometry: THREE.BufferGeometry; material: THREE.Material }, mats: THREE.Matrix4[], shadow = false) {
    if (!mats.length) return;
    const TILE = CELL * 2;
    const tiles = new Map<string, THREE.Matrix4[]>();
    for (const m of mats) {
      const key = `${Math.floor(m.elements[12] / TILE)}|${Math.floor(m.elements[14] / TILE)}`;
      const l = tiles.get(key);
      if (l) l.push(m);
      else tiles.set(key, [m]);
    }
    for (const list of tiles.values()) {
      const im = new THREE.InstancedMesh(prop.geometry, prop.material, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      im.castShadow = shadow;
      im.receiveShadow = true;
      scene.add(im);
    }
  }

  // Einfache Kiefer aus Zylinder und Kegeln (Vertexfarben), ca. 6 m hoch
  function treeGeometry() {
    const part = (g: THREE.BufferGeometry, color: number, y: number) => {
      g.translate(0, y, 0);
      const c = new THREE.Color(color);
      const arr = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };
    return mergeGeometries([
      part(new THREE.CylinderGeometry(0.22, 0.32, 2.0, 7), 0x6b4a2e, 1.0),
      part(new THREE.ConeGeometry(2.0, 2.6, 8), 0x2f7a46, 2.9),
      part(new THREE.ConeGeometry(1.55, 2.4, 8), 0x37894f, 4.2),
      part(new THREE.ConeGeometry(1.0, 2.1, 8), 0x41985a, 5.4),
    ])!;
  }

  function addMap(city: City) {
    markings();
    // Parks: ein ganzer Block
    const grass = mat(0x5f9a4a);
    for (const p of city.parks) {
      const park = box(29, 0.05, 29, grass, p.x, 0.02, p.z);
      park.receiveShadow = true;
      scene.add(park);
    }
    if (!assets) {
      fallbackBuildings(city.boxes);
      return;
    }
    // Gebaeude: eine InstancedMesh pro Modell und Kachel (2 x 2 Bloecke). So zeichnet die Grafikkarte
    // nur die Kacheln, die im Bild liegen, und die Draw Calls bleiben niedrig.
    const mx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const TILE = CELL * 2;
    const groups = new Map<string, Box[]>();
    for (const b of city.boxes) {
      const key = `${b.k}|${Math.floor(b.px / TILE)}|${Math.floor(b.pz / TILE)}`;
      const g = groups.get(key);
      if (g) g.push(b);
      else groups.set(key, [b]);
    }
    for (const [key, list] of groups) {
      const prop = assets.buildings[Number(key.split('|')[0])];
      const inst = new THREE.InstancedMesh(prop.geometry, prop.material, list.length);
      list.forEach((b, i) => {
        q.setFromAxisAngle(up, (b.rot * Math.PI) / 2);
        mx.compose(new THREE.Vector3(b.px, 0, b.pz), q, new THREE.Vector3(b.s, b.s, b.s));
        inst.setMatrixAt(i, mx);
      });
      inst.computeBoundingSphere();
      inst.castShadow = inst.receiveShadow = true;
      scene.add(inst);
    }
    const M = (x: number, y: number, z: number, rot: number, s = 1) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(up, rot), new THREE.Vector3(s, s, s));
    // Strassenlaternen und Ampeln an den Ecken der Kreuzungen (Arm zeigt zur Kreuzungsmitte)
    const lamps: THREE.Matrix4[] = [];
    const tls: THREE.Matrix4[][] = [[], [], []];
    const E = 12.6;
    let n = 0;
    for (let i = -9; i <= 8; i++) {
      for (let j = -9; j <= 8; j++) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        if (Math.abs(cx) < 40 && Math.abs(cz) < 40) continue;
        lamps.push(M(cx + E, 0, cz + E, -Math.PI / 4));
        if (n % 3 !== 2) tls[n % 3].push(M(cx - E, 0, cz - E, (3 * Math.PI) / 4));
        n++;
      }
    }
    instanced(assets.streetlight, lamps);
    instanced(assets.props.tlA, tls[0]);
    instanced(assets.props.tlB, tls[1]);
    instanced(assets.props.tlC, tls[2]);
    // Parks: Struktur aus Buschwerk, Baeumen und Baenken
    const bushes: THREE.Matrix4[] = [];
    const benches: THREE.Matrix4[] = [];
    const trees: THREE.Matrix4[] = [];
    city.parks.forEach((p, pi) => {
      for (let k = 0; k < 10; k++) {
        bushes.push(M(p.x + (rnd(pi * 40 + k) - 0.5) * 25, 0, p.z + (rnd(pi * 40 + k + 17) - 0.5) * 25, k, 0.9 + rnd(k + pi) * 0.6));
      }
      for (let k = 0; k < 12; k++) {
        trees.push(M(p.x + (rnd(pi * 50 + k + 3) - 0.5) * 24, 0, p.z + (rnd(pi * 50 + k + 29) - 0.5) * 24, rnd(k) * 6, 0.8 + rnd(pi + k * 3) * 0.6));
      }
      for (let k = 0; k < 4; k++) benches.push(M(p.x + (k % 2 ? 4 : -4), 0, p.z + (k < 2 ? -9 : 9), ((k % 2 ? 1 : -1) * Math.PI) / 2));
    });
    instanced(assets.bush, bushes);
    instanced(assets.props.bench, benches);
    if (trees.length) instanced({ geometry: treeGeometry(), material: new THREE.MeshLambertMaterial({ vertexColors: true }) }, trees, true);
    // Strassenmoebel vor den Gebaeuden (nur auf den Aussenseiten der Bloecke) und Wassertuerme auf Daechern
    const P = assets.props;
    const kindProps = [P.hydrant, P.trash, P.bench, P.dumpster, P.boxA, P.boxB, P.barrel, P.pallet, P.crate];
    const kinds: THREE.Matrix4[][] = kindProps.map(() => []);
    const towers: THREE.Matrix4[] = [];
    city.boxes.forEach((b, idx) => {
      if (rnd(idx * 5 + 1) < 0.55) {
        const bx = Math.round(b.px / CELL) * CELL;
        const bz = Math.round(b.pz / CELL) * CELL;
        const sx = b.px >= bx ? 1 : -1;
        const sz = b.pz >= bz ? 1 : -1;
        const out = b.s + 0.7;
        const alongA = (rnd(idx * 5 + 3) - 0.5) * b.s * 1.4;
        const kind = Math.floor(rnd(idx * 5 + 4) * kindProps.length);
        if (rnd(idx * 5 + 2) < 0.5) kinds[kind].push(M(b.px + alongA, 0, b.pz + sz * out, sz > 0 ? 0 : Math.PI));
        else kinds[kind].push(M(b.px + sx * out, 0, b.pz + alongA, sx > 0 ? Math.PI / 2 : -Math.PI / 2));
      }
      if (b.h > 12 && rnd(idx * 7 + 3) < 0.15) towers.push(M(b.x, b.h, b.z, rnd(idx + 4) * 6, 0.55));
    });
    kindProps.forEach((pp, k) => instanced(pp, kinds[k]));
    instanced(P.tower, towers, true);
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
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true, toneMapped: false }));
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

  const clipCache = new WeakMap<THREE.AnimationClip[], Map<string, { lower: THREE.AnimationClip; upper: THREE.AnimationClip }>>();
  function splitFor(clips: THREE.AnimationClip[], name: string) {
    let m = clipCache.get(clips);
    if (!m) clipCache.set(clips, (m = new Map()));
    let r = m.get(name);
    if (!r) {
      const c = THREE.AnimationClip.findByName(clips, name) ?? clips[0];
      m.set(name, (r = splitClip(c)));
    }
    return r;
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
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      const holder = new THREE.Group();
      holder.add(model);
      root.add(holder);
      const mixer = new THREE.AnimationMixer(model);
      mixers.add(mixer);
      // Reihenfolge: Idle, Vor, Links, Rechts, Zurueck
      const names = ['Idle', 'Running_A', 'Running_Strafe_Left', 'Running_Strafe_Right', 'Walking_Backwards'];
      const lower: THREE.AnimationAction[] = [];
      const upper: THREE.AnimationAction[] = [];
      for (const n of names) {
        const sp = splitFor(a.clips, n);
        const lo = mixer.clipAction(sp.lower);
        const up = mixer.clipAction(sp.upper);
        lo.play().setEffectiveWeight(n === 'Idle' ? 1 : 0);
        up.play().setEffectiveWeight(n === 'Idle' ? 1 : 0);
        lower.push(lo);
        upper.push(up);
      }
      const aim = mixer.clipAction(splitFor(a.clips, '1H_Ranged_Shoot').upper);
      aim.play().setEffectiveWeight(0);
      const death = mixer.clipAction(THREE.AnimationClip.findByName(a.clips, 'Death_A') ?? a.clips[0]);
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
      death.setEffectiveWeight(0);
      // Muendungsfeuer vor der Waffenhand (haengt am Koerper, dreht sich mit)
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      flash.position.set(0.32, 1.28, -1.4);
      flash.visible = false;
      holder.add(flash);
      root.userData.anim = {
        mixer,
        holder,
        flash,
        lower,
        upper,
        aim,
        death,
        w: [1, 0, 0, 0, 0],
        aimW: 0,
        deadW: 0,
        dead: false,
        yaw: 0,
        fireUntil: 0,
        flashUntil: 0,
      } as PlayerAnim;
    } else {
      root.add(simplePlayer(hue));
    }
    if (name) root.add(label(name));
    return root;
  }

  const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

  function animatePlayer(o: THREE.Object3D, s: PlayerAnimState) {
    const an = o.userData.anim as PlayerAnim | undefined;
    if (!an) {
      o.rotation.y = s.yaw;
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, s.dt);
    // Koerper dreht sich schnell, aber weich zur Blickrichtung (statt sofort zu springen)
    const firing = now < an.fireUntil;
    if (!an.dead && !s.dead) {
      an.yaw += angDiff(s.yaw, an.yaw) * (1 - Math.exp(-(firing ? 28 : 16) * dt));
    }
    an.holder.rotation.y = an.yaw;

    if (s.dead !== an.dead) {
      an.dead = s.dead;
      if (s.dead) an.death.reset().play();
      else an.death.stop();
    }
    // Zielgewichte aus der Bewegungsrichtung relativ zur Koerperrichtung
    const speed = Math.hypot(s.vx, s.vz);
    const moving = Math.min(1, Math.max(0, (speed - 0.6) / 1.6));
    const fwd = -(s.vx * Math.sin(an.yaw) + s.vz * Math.cos(an.yaw));
    const side = s.vx * Math.cos(an.yaw) - s.vz * Math.sin(an.yaw);
    const mag = Math.hypot(fwd, side) || 1;
    const cf = fwd / mag;
    const cs = side / mag;
    const raw = [0, Math.max(0, cf), Math.max(0, -cs), Math.max(0, cs), Math.max(0, -cf)];
    const sum = raw[1] + raw[2] + raw[3] + raw[4] || 1;
    const target = [1 - moving, 0, 0, 0, 0];
    for (let i = 1; i < 5; i++) target[i] = (raw[i] / sum) * moving;
    const k = 1 - Math.exp(-12 * dt);
    for (let i = 0; i < 5; i++) an.w[i] += (target[i] - an.w[i]) * k;
    an.aimW += ((firing && !s.dead ? 1 : 0) - an.aimW) * (1 - Math.exp(-(firing ? 22 : 7) * dt));
    an.deadW += ((s.dead ? 1 : 0) - an.deadW) * (1 - Math.exp(-14 * dt));
    const alive = 1 - an.deadW;
    const ts = Math.min(1.6, Math.max(0.75, speed / 6.5));
    for (let i = 0; i < 5; i++) {
      an.lower[i].setEffectiveWeight(an.w[i] * alive);
      an.upper[i].setEffectiveWeight(an.w[i] * alive * (1 - an.aimW));
      if (i > 0) {
        an.lower[i].timeScale = ts;
        an.upper[i].timeScale = ts;
      }
    }
    an.aim.setEffectiveWeight(an.aimW * alive);
    an.death.setEffectiveWeight(an.deadW);
    // Muendungsfeuer
    const on = now < an.flashUntil;
    an.flash.visible = on;
    if (on) {
      const sz = 0.7 + Math.random() * 0.5;
      an.flash.scale.set(sz, sz, 1);
      (an.flash.material as THREE.SpriteMaterial).rotation = Math.random() * 6;
    }
  }

  function playerFired(o: THREE.Object3D) {
    const an = o.userData.anim as PlayerAnim | undefined;
    const now = performance.now();
    if (!an) return;
    // Zielhaltung bleibt noch etwas nach dem letzten Schuss, damit es nicht flackert
    an.fireUntil = now + 450;
    an.flashUntil = now + 60;
    const p = new THREE.Vector3();
    an.flash.getWorldPosition(p);
    for (let i = 0; i < 3; i++) fire.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.12, 0.5, 0.1, 1, 0.75, 0.3, 0.7);
    smoke.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 0.6, 0.8, (Math.random() - 0.5) * 0.6, 0.7, 0.2, 0.7, 0.75, 0.75, 0.75, 0.28, 0, 1.5);
  }

  function disposeObject(o: THREE.Object3D) {
    const an = o.userData.anim as PlayerAnim | undefined;
    if (an) {
      an.mixer.stopAllAction();
      mixers.delete(an.mixer);
    }
    spinners.delete(o);
  }

  // ---------------------------------------------------------------- Fahrzeuge
  function shadowize(o: THREE.Object3D) {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) c.castShadow = true;
    });
    return o;
  }

  function makeCar(hue: number, id: number) {
    if (assets) {
      const car = assets.cars[id % assets.cars.length].clone(true);
      car.userData.wheels = [] as THREE.Object3D[];
      car.traverse((o) => {
        if (/wheel/i.test(o.name)) car.userData.wheels.push(o);
      });
      return shadowize(car);
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
    return shadowize(g);
  }

  function spinWheels(o: THREE.Object3D, meters: number) {
    const ws = o.userData.wheels as THREE.Object3D[] | undefined;
    if (!ws) return;
    const radius = (o.userData.wheelR as number) || 0.35;
    for (const w of ws) w.rotation.x -= meters / radius;
  }

  // Flugzeug (selbst gebaut): Rumpf, Fluegel, Leitwerk, Fahrwerk und ein drehender Propeller
  const planeGeo = {
    fuselage: new THREE.CylinderGeometry(0.62, 0.42, 5.2, 14).rotateX(Math.PI / 2), // Nase bei -z
    tail: new THREE.CylinderGeometry(0.42, 0.12, 2.4, 10).rotateX(Math.PI / 2),
    nose: new THREE.SphereGeometry(0.62, 14, 10),
    canopy: new THREE.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    wing: new THREE.BoxGeometry(11, 0.14, 1.9),
    tip: new THREE.BoxGeometry(0.9, 0.16, 1.6),
    stab: new THREE.BoxGeometry(3.6, 0.1, 1.0),
    fin: new THREE.BoxGeometry(0.12, 1.5, 1.2),
    wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.22, 12).rotateZ(Math.PI / 2),
    strut: new THREE.BoxGeometry(0.1, 0.8, 0.1),
    blade: new THREE.BoxGeometry(0.22, 2.3, 0.05),
    disc: new THREE.CircleGeometry(1.15, 16),
  };
  function makePlane(hue: number) {
    const g = new THREE.Group();
    const col = new THREE.Color().setHSL(hue / 360, 0.65, 0.5);
    const white = mat(0xf0f1f2);
    const accent = mat(col);
    const dark = mat(0x222428);
    const glass = new THREE.MeshLambertMaterial({ color: 0x7fb4d8, emissive: 0x0a1a28 });
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };
    add(planeGeo.fuselage, white, 0, 1.45, 0);
    add(planeGeo.tail, white, 0, 1.55, 3.7);
    add(planeGeo.nose, accent, 0, 1.45, -2.6).scale.set(1, 1, 0.9);
    add(planeGeo.canopy, glass, 0, 1.85, -0.6).scale.set(1, 1, 1.9);
    add(planeGeo.wing, white, 0, 1.15, -0.3);
    add(planeGeo.tip, accent, -5.4, 1.15, -0.3);
    add(planeGeo.tip, accent, 5.4, 1.15, -0.3);
    add(planeGeo.stab, accent, 0, 1.65, 4.6);
    add(planeGeo.fin, accent, 0, 2.3, 4.5);
    for (const sx of [-1, 1]) {
      add(planeGeo.strut, dark, sx * 0.9, 0.75, -0.9);
      add(planeGeo.wheel, dark, sx * 0.9, 0.34, -0.9);
    }
    add(planeGeo.wheel, dark, 0, 0.36, 4.3).scale.setScalar(0.6);
    const prop = new THREE.Group();
    prop.position.set(0, 1.45, -3.2);
    const b1 = new THREE.Mesh(planeGeo.blade, dark);
    const b2 = b1.clone();
    b2.rotation.z = Math.PI / 2;
    const disc = new THREE.Mesh(planeGeo.disc, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    prop.add(b1, b2, disc);
    g.add(prop);
    g.userData.prop = prop;
    g.scale.setScalar(0.75); // Spannweite ca. 8 m: passt noch zwischen die Haeuser
    spinners.add(g);
    return g;
  }

  function makeRocket() {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 1.0), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    return g;
  }

  // ---------------------------------------------------------------- Einschusslöcher und Brandflecken
  // Ein Ring aus Decals (eine InstancedMesh, ein Draw Call). Das Verblassen rechnet der Shader aus dem Alter.
  const DECALS = 320;
  const decalUniforms = { uNow: { value: 0 } };
  const decalGeo = new THREE.PlaneGeometry(1, 1);
  const decalT = new THREE.InstancedBufferAttribute(new Float32Array(DECALS).fill(-1e6), 1);
  const decalL = new THREE.InstancedBufferAttribute(new Float32Array(DECALS).fill(1), 1);
  const decalK = new THREE.InstancedBufferAttribute(new Float32Array(DECALS), 1);
  decalGeo.setAttribute('aT', decalT);
  decalGeo.setAttribute('aL', decalL);
  decalGeo.setAttribute('aK', decalK);
  const decals = new THREE.InstancedMesh(
    decalGeo,
    new THREE.ShaderMaterial({
      uniforms: decalUniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: `attribute float aT; attribute float aL; attribute float aK; uniform float uNow;
        varying vec2 vUv; varying float vA; varying float vK;
        void main(){ vUv = uv; vK = aK; float age = (uNow - aT) / aL;
          vA = (age < 0.0 || age > 1.0) ? 0.0 : 1.0 - smoothstep(0.5, 1.0, age);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vA; varying float vK;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          if (vA <= 0.001) discard;
          vec2 c = vUv * 2.0 - 1.0; float d = length(c);
          float a;
          if (vK < 0.5) { // Einschussloch: schwarzer Kern, rauer Rand, heller Abplatzring
            float rough = 0.78 + 0.22 * h(floor(vUv * 9.0));
            float core = smoothstep(0.34 * rough + 0.1, 0.2, d);
            float ring = smoothstep(1.0, 0.45, d) * 0.28;
            a = max(core * 0.96, ring);
          } else { // Brandfleck: weiche, ungleichmaessige Russflaeche
            vec2 g = vUv * 6.0; vec2 i = floor(g); vec2 f = fract(g); f = f * f * (3.0 - 2.0 * f);
            float n = mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y);
            a = smoothstep(1.0, 0.2, d * (0.75 + 0.5 * n)) * 0.5;
          }
          gl_FragColor = vec4(vec3(0.015), a * vA);
        }`,
    }),
    DECALS,
  );
  decals.frustumCulled = false;
  decals.renderOrder = 2;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < DECALS; i++) decals.setMatrixAt(i, zero);
  scene.add(decals);
  let decalNext = 0;
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  function addDecal(x: number, y: number, z: number, n: THREE.Vector3, size: number, life: number, kind: 0 | 1) {
    const i = decalNext;
    decalNext = (decalNext + 1) % DECALS;
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    _q2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * 6.28);
    _q.multiply(_q2);
    const off = kind === 0 ? 0.035 : 0.025;
    _m.compose(new THREE.Vector3(x + n.x * off, y + n.y * off, z + n.z * off), _q, new THREE.Vector3(size, size, 1));
    decals.setMatrixAt(i, _m);
    decals.instanceMatrix.needsUpdate = true;
    decalT.setX(i, performance.now() / 1000);
    decalL.setX(i, life);
    decalK.setX(i, kind);
    decalT.needsUpdate = decalL.needsUpdate = decalK.needsUpdate = true;
  }

  // Oberflaechennormale am Einschlagpunkt (Boden, Dach oder Gebaeudewand)
  let cityBoxes: Box[] = [];
  function surfaceNormal(x: number, y: number, z: number): THREE.Vector3 {
    if (y < 0.12) return new THREE.Vector3(0, 1, 0);
    let best: Box | null = null;
    let bestScore = -Infinity;
    for (const b of cityBoxes) {
      const dx = Math.abs(x - b.x) - b.hw;
      const dz = Math.abs(z - b.z) - b.hd;
      if (dx > 0.4 || dz > 0.4 || y > b.h + 0.4) continue;
      const score = Math.max(dx, dz);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return new THREE.Vector3(0, 1, 0);
    if (y > best.h - 0.2) return new THREE.Vector3(0, 1, 0);
    const dx = Math.abs(x - best.x) - best.hw;
    const dz = Math.abs(z - best.z) - best.hd;
    return dx > dz ? new THREE.Vector3(Math.sign(x - best.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(z - best.z));
  }

  // ---------------------------------------------------------------- Effekte
  const streakMat = () => new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const streakGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
  let shakeAmp = 0;

  function sparks(x: number, y: number, z: number, n: THREE.Vector3, metal = false) {
    // Funken fliegen von der Flaeche weg, dazu ein Staubpuff
    for (let i = 0; i < (metal ? 12 : 8); i++) {
      const v = 3 + Math.random() * 8;
      const sx = n.x * v + (Math.random() - 0.5) * 6;
      const sy = n.y * v + 1 + Math.random() * 4;
      const sz = n.z * v + (Math.random() - 0.5) * 6;
      fire.emit(x, y, z, sx, sy, sz, 0.25 + Math.random() * 0.3, 0.18, 0.03, 1, 0.75 + Math.random() * 0.2, 0.3, 1, -20, 0.6);
    }
    fire.emit(x, y, z, 0, 0, 0, 0.09, 0.9, 0.2, 1, 0.9, 0.55, 0.9); // kurzer Aufblitz
    const g = 0.55 + Math.random() * 0.15;
    smoke.emit(x + n.x * 0.1, y + n.y * 0.1, z + n.z * 0.1, n.x * 0.6, 0.5 + n.y * 0.6, n.z * 0.6, 0.8, 0.3, 1.3, g, g, g, 0.35, 0, 1.3);
  }

  function bloodPuff(x: number, y: number, z: number) {
    for (let i = 0; i < 5; i++) smoke.emit(x, y, z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, 0.5, 0.25, 0.7, 0.55, 0.05, 0.05, 0.6, -4, 2);
  }

  // hit: 0 = nichts getroffen, 1 = Spieler, 2 = Fahrzeug; wl = 1: Wand oder Boden getroffen
  function tracer(a: number[], b: number[], hit = 0, wl = 0) {
    const A = new THREE.Vector3(a[0], a[1] - 0.2, a[2]);
    const B = new THREE.Vector3(b[0], b[1], b[2]);
    const len = A.distanceTo(B);
    const m = new THREE.Mesh(streakGeo, streakMat());
    m.frustumCulled = false;
    scene.add(m);
    const t = performance.now();
    const dur = Math.min(260, Math.max(70, (len / 320) * 1000));
    effects.push({ obj: m, until: t + dur, start: t, kind: 'tracer', a: A, b: B, len });
    timers.push({
      at: t + dur,
      fn: () => {
        if (wl) {
          const n = surfaceNormal(B.x, B.y, B.z);
          sparks(B.x, B.y, B.z, n);
          addDecal(B.x, B.y, B.z, n, 0.24 + Math.random() * 0.1, 28, 0);
        } else if (hit === 2) sparks(B.x, B.y, B.z, new THREE.Vector3(0, 1, 0), true);
        else if (hit === 1) bloodPuff(B.x, B.y, B.z);
      },
    });
  }

  function boom(x: number, y: number, z: number, r: number) {
    const t = performance.now();
    const k = r / 6;
    // Grelle Kugel im Kern, schnell vergehend
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    s.position.set(x, y, z);
    scene.add(s);
    effects.push({ obj: s, until: t + 200, start: t, kind: 'boom', r: r * 0.8 });
    // Druckwelle am Boden
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffe9c8, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y > 3 ? 0.15 : Math.max(0.15, y * 0.2), z);
    scene.add(ring);
    effects.push({ obj: ring, until: t + 520, start: t, kind: 'ring', r: r * 2.2 });
    // Feuerball: grosse weiche Flammen, die aufsteigen
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.28;
      const e = Math.random();
      const v = (2 + Math.random() * 6) * k;
      fire.emit(x, y, z, Math.cos(a) * v * e, (2 + Math.random() * 7) * k, Math.sin(a) * v * e, 0.55 + Math.random() * 0.55, 2.5 * k + Math.random() * 2, 0.8, 1, 0.5 + Math.random() * 0.35, 0.1 + Math.random() * 0.1, 0.9, 4, 1.4);
    }
    // Funken und glühende Splitter
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.28;
      const v = (6 + Math.random() * 16) * k;
      fire.emit(x, y, z, Math.cos(a) * v, (3 + Math.random() * 14) * k, Math.sin(a) * v, 0.5 + Math.random() * 0.9, 0.2, 0.04, 1, 0.65 + Math.random() * 0.3, 0.2, 1, -18, 0.4);
    }
    // Truemmer: dunkle Brocken fallen zu Boden
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * 6.28;
      const v = (4 + Math.random() * 12) * k;
      smoke.emit(x, y, z, Math.cos(a) * v, (5 + Math.random() * 12) * k, Math.sin(a) * v, 1 + Math.random() * 0.8, 0.45, 0.4, 0.1, 0.09, 0.09, 1, -22, 0.15);
    }
    // Rauchsaeule: steigt mehrere Sekunden auf
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * 6.28;
      const v = Math.random() * 3.5 * k;
      const dark = 0.2 + Math.random() * 0.18;
      smoke.emit(x + Math.cos(a) * 1.2, y, z + Math.sin(a) * 1.2, Math.cos(a) * v, (2.5 + Math.random() * 4.5) * k, Math.sin(a) * v, 2.2 + Math.random() * 2.2, 2.5 * k, (6 + Math.random() * 5) * k, dark, dark, dark + 0.02, 0.42, 0, 0.9);
    }
    // Brandfleck am Boden
    if (y < 6) addDecal(x, 0.02, z, new THREE.Vector3(0, 1, 0), r * 1.7, 55, 1);
    // Kamerawackeln je nach Entfernung
    const d = Math.hypot(camera.position.x - x, camera.position.y - y, camera.position.z - z);
    shakeAmp = Math.max(shakeAmp, Math.max(0, 1 - d / (45 * k)) * 0.9 * Math.min(1.5, k));
  }

  function dust(x: number, z: number, speed: number) {
    const a = (Math.random() - 0.5) * 2;
    smoke.emit(x + a, 0.25, z + (Math.random() - 0.5) * 2, a * 0.5, 0.6, 0, 0.9, 0.5, 2.2 + speed * 0.05, 0.62, 0.6, 0.55, 0.2, 0, 1.2);
  }

  // Fahrzeugschaden: ab halber Gesundheit raucht es, bei wenig Leben qualmt es dunkel mit Flammen,
  // bei 0 Leben brennt es lichterloh, bis es nach einigen Sekunden explodiert.
  const _v = new THREE.Vector3();
  function vehicleFx(o: THREE.Object3D, kind: number, hpRatio: number, burning: boolean, dt: number) {
    const stage = burning ? 3 : hpRatio < 0.25 ? 2 : hpRatio < 0.5 ? 1 : 0;
    let glowSp = o.userData.glow as THREE.Sprite | undefined;
    if (stage === 0) {
      if (glowSp) glowSp.visible = false;
      return;
    }
    const rate = [0, 9, 20, 55][stage];
    o.userData.fxAcc = (o.userData.fxAcc ?? 0) + rate * dt;
    // Motorraum: Auto vorn, Flugzeug an der Nase
    const local = kind === 2 ? _v.set(0, 1.45, -2.2) : _v.set(0, 1.05, -1.5);
    const wp = o.localToWorld(local.clone());
    while (o.userData.fxAcc >= 1) {
      o.userData.fxAcc -= 1;
      const j = () => (Math.random() - 0.5) * 1.6;
      if (stage === 1) {
        const g = 0.5 + Math.random() * 0.15;
        smoke.emit(wp.x + j() * 0.3, wp.y, wp.z + j() * 0.3, j() * 0.4, 1.6 + Math.random(), j() * 0.4, 1.4, 0.5, 2.2, g, g, g, 0.32, 0, 0.6);
      } else {
        const dark = stage === 3 ? 0.07 + Math.random() * 0.08 : 0.15 + Math.random() * 0.12;
        smoke.emit(wp.x + j() * 0.4, wp.y + 0.2, wp.z + j() * 0.4, j() * 0.6, 2.4 + Math.random() * 2, j() * 0.6, 2.2 + Math.random(), 0.7, stage === 3 ? 4.5 : 3, dark, dark, dark, 0.4, 0, 0.5);
        if (stage >= 2 && Math.random() < (stage === 3 ? 0.95 : 0.4)) {
          fire.emit(wp.x + j() * 0.6, wp.y + 0.1, wp.z + j() * 0.6, j() * 0.5, 1.5 + Math.random() * 2.4, j() * 0.5, 0.45 + Math.random() * 0.3, stage === 3 ? 1.7 : 1.0, 0.2, 1, 0.45 + Math.random() * 0.35, 0.08, 0.9, 1, 0.8);
        }
      }
    }
    if (stage >= 2) {
      if (!glowSp) {
        glowSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
        glowSp.position.copy(kind === 2 ? new THREE.Vector3(0, 1.5, -1.5) : new THREE.Vector3(0, 1.2, -1.0));
        o.add(glowSp);
        o.userData.glow = glowSp;
      }
      glowSp.visible = true;
      const f = (stage === 3 ? 6 : 3) * (0.85 + Math.random() * 0.3);
      glowSp.scale.set(f, f, 1);
    }
  }

  function update(nowMs: number, dt: number) {
    for (const m of mixers) m.update(dt);
    skyUniforms.uTime.value = nowMs / 1000;
    decalUniforms.uNow.value = performance.now() / 1000;
    for (const o of spinners) {
      const p = o.userData.prop as THREE.Object3D;
      p.rotation.z += dt * (o.userData.spin ?? 38);
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      if (nowMs >= timers[i].at) {
        const fn = timers[i].fn;
        timers.splice(i, 1);
        fn();
      }
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const k = Math.min(1, (nowMs - e.start) / (e.until - e.start));
      if (nowMs >= e.until) {
        scene.remove(e.obj);
        const mesh = e.obj as THREE.Mesh;
        if (e.kind !== 'tracer') mesh.geometry?.dispose();
        (mesh.material as THREE.Material).dispose();
        effects.splice(i, 1);
      } else if (e.kind === 'boom') {
        e.obj.scale.setScalar((e.r ?? 6) * (0.2 + k * 0.9));
        ((e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - k) * (1 - k);
      } else if (e.kind === 'ring') {
        e.obj.scale.setScalar((e.r ?? 6) * (0.15 + k * 0.85));
        ((e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
      } else if (e.kind === 'tracer' && e.a && e.b && e.len) {
        // Leuchtspur: ein kurzes Stueck, das vom Lauf zum Ziel fliegt
        const tail = 7;
        const head = Math.min(e.len, k * (e.len + tail));
        const back = Math.max(2.5, head - tail); // die ersten Meter vor der Kamera bleiben frei
        const dir = e.b.clone().sub(e.a).normalize();
        const mid = e.a.clone().addScaledVector(dir, (head + back) / 2);
        e.obj.position.copy(mid);
        e.obj.lookAt(mid.clone().add(dir));
        e.obj.scale.set(1, 1, Math.max(0.001, head - back));
        ((e.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - k * 0.6;
      }
    }
    // Partikel skalieren mit der Aufloesung und dem Sichtfeld
    const h = renderer.domElement.height || 600;
    uScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    fire.update(dt);
    smoke.update(dt);
    skyDome.position.copy(camera.position);
    if (shakeAmp > 0.003) {
      camera.position.x += (Math.random() - 0.5) * shakeAmp;
      camera.position.y += (Math.random() - 0.5) * shakeAmp;
      camera.position.z += (Math.random() - 0.5) * shakeAmp;
      shakeAmp *= Math.exp(-5 * dt);
    } else shakeAmp = 0;
    autoQuality(dt);
  }

  // ---------------------------------------------------------------- Qualitaet
  let ema = 1 / 60;
  let slow = 0;
  function setQuality(q: 'high' | 'low') {
    if (q === quality) return;
    quality = q;
    sun.castShadow = q === 'high';
    renderer.setPixelRatio(pixelRatio());
    resize();
  }
  function autoQuality(dt: number) {
    if (document.visibilityState !== 'visible' || dt >= 0.1) return;
    ema += (dt - ema) * 0.05;
    if (!auto || quality === 'low') return;
    slow = ema > 1 / 28 ? slow + dt : 0;
    if (slow > 3) {
      setQuality('low');
      console.info('Wenige Bilder pro Sekunde: Schatten aus, Aufloesung gesenkt');
    }
  }

  function focus(x: number, y: number, z: number) {
    const fx = Math.round(x * 2) / 2;
    const fz = Math.round(z * 2) / 2;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + SUN_DIR.x * 200, SUN_DIR.y * 200, fz + SUN_DIR.z * 200);
    sun.target.updateMatrixWorld();
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
    addMap: (c) => {
      cityBoxes = c.boxes;
      addMap(c);
    },
    makePlayer,
    animatePlayer,
    playerFired,
    disposeObject,
    makeCar,
    spinWheels,
    makePlane,
    makeRocket,
    tracer,
    vehicleFx,
    boom,
    update,
    resize,
    focus,
    dust,
    info: () => ({ quality, fps: Math.round(1 / ema) }),
  };
}
