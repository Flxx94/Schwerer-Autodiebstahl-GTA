// Touch-Steuerung (und Tastatur zum Testen am Rechner).
// Links: schwebender Joystick. Rechts: Wischen = Kamera. Buttons: Feuer, Einsteigen, Spawn, Waffe.
import { clamp } from '../../shared/sim';

export const ctl = {
  mx: 0,
  mz: 0,
  yaw: 0,
  pitch: 0.12,
  fire: false,
  thr: 0, // Schubregler 0..1
  hasTouch: false,
};

export interface Actions {
  enter(): void;
  spawn(kind: 'car' | 'plane'): void;
  weapon(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initControls(act: Actions) {
  const leftZone = $('leftZone');
  const rightZone = $('rightZone');
  const base = $('joyBase');
  const knob = $('joyKnob');
  const R = 55; // Joystick-Radius in px

  // ---- Joystick links (erscheint dort, wo der Daumen aufsetzt) ----
  let joyId = -1;
  let jx = 0;
  let jy = 0;
  const setJoy = (e: PointerEvent) => {
    let dx = e.clientX - jx;
    let dy = e.clientY - jy;
    const l = Math.hypot(dx, dy);
    if (l > R) {
      dx = (dx / l) * R;
      dy = (dy / l) * R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    ctl.mx = dx / R;
    ctl.mz = -dy / R;
  };
  leftZone.addEventListener('pointerdown', (e) => {
    if (joyId !== -1) return;
    joyId = e.pointerId;
    leftZone.setPointerCapture(e.pointerId);
    ctl.hasTouch = e.pointerType !== 'mouse' || ctl.hasTouch;
    const rect = leftZone.getBoundingClientRect();
    jx = e.clientX;
    jy = e.clientY;
    base.style.display = 'block';
    base.style.left = `${jx - rect.left}px`;
    base.style.top = `${jy - rect.top}px`;
    knob.style.transform = '';
    setJoy(e);
  });
  leftZone.addEventListener('pointermove', (e) => {
    if (e.pointerId === joyId) setJoy(e);
  });
  const endJoy = (e: PointerEvent) => {
    if (e.pointerId !== joyId) return;
    joyId = -1;
    base.style.display = 'none';
    ctl.mx = 0;
    ctl.mz = 0;
  };
  leftZone.addEventListener('pointerup', endJoy);
  leftZone.addEventListener('pointercancel', endJoy);

  // ---- Kamera rechts: Wischen. Auch ueber dem Feuer-Button, damit ein Daumen reicht ----
  const lookOn = (el: HTMLElement) => {
    let id = -1;
    let lx = 0;
    let ly = 0;
    el.addEventListener('pointerdown', (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      ctl.yaw -= (e.clientX - lx) * 0.006;
      ctl.pitch = clamp(ctl.pitch - (e.clientY - ly) * 0.005, -0.9, 1.0);
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === id) id = -1;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  lookOn(rightZone);

  // ---- Buttons ----
  const fireBtn = $('btnFire');
  lookOn(fireBtn);
  fireBtn.addEventListener('pointerdown', () => {
    ctl.fire = true;
    fireBtn.classList.add('on');
  });
  const stopFire = () => {
    ctl.fire = false;
    fireBtn.classList.remove('on');
  };
  fireBtn.addEventListener('pointerup', stopFire);
  fireBtn.addEventListener('pointercancel', stopFire);

  const tap = (id: string, fn: () => void) => {
    $(id).addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fn();
    });
  };
  const menu = $('spawnMenu');
  tap('btnEnter', () => act.enter());
  tap('btnWeapon', () => act.weapon());
  tap('btnSpawn', () => menu.classList.toggle('open'));
  tap('spawnCar', () => {
    menu.classList.remove('open');
    act.spawn('car');
  });
  tap('spawnPlane', () => {
    menu.classList.remove('open');
    act.spawn('plane');
  });

  // ---- Schubregler (nur im Flugzeug sichtbar) ----
  const thr = $('throttle');
  const fill = $('throttleFill');
  let thrId = -1;
  const setThr = (e: PointerEvent) => {
    const r = thr.getBoundingClientRect();
    ctl.thr = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    fill.style.height = `${ctl.thr * 100}%`;
  };
  thr.addEventListener('pointerdown', (e) => {
    thrId = e.pointerId;
    thr.setPointerCapture(e.pointerId);
    setThr(e);
  });
  thr.addEventListener('pointermove', (e) => {
    if (e.pointerId === thrId) setThr(e);
  });
  const endThr = (e: PointerEvent) => {
    if (e.pointerId === thrId) thrId = -1;
  };
  thr.addEventListener('pointerup', endThr);
  thr.addEventListener('pointercancel', endThr);

  // ---- Tastatur (zum Testen am Rechner): WASD/Pfeile, Leertaste, E, C, V, Q, R/F fuer Schub ----
  const keys = new Set<string>();
  const upd = () => {
    if (joyId !== -1) return;
    ctl.mx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    ctl.mz = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (e.repeat) return;
    if (k === ' ') ctl.fire = true;
    else if (k === 'e') act.enter();
    else if (k === 'c') act.spawn('car');
    else if (k === 'v') act.spawn('plane');
    else if (k === 'q') act.weapon();
    else keys.add(k);
    upd();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') ctl.fire = false;
    keys.delete(k);
    upd();
  });
  setInterval(() => {
    if (keys.has('r')) ctl.thr = clamp(ctl.thr + 0.03, 0, 1);
    if (keys.has('f')) ctl.thr = clamp(ctl.thr - 0.03, 0, 1);
    if (keys.has('r') || keys.has('f')) fill.style.height = `${ctl.thr * 100}%`;
  }, 50);

  // Browser-Gesten (Zoom, Kontextmenue) abstellen
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

export function setThrottleVisible(v: boolean) {
  $('throttle').style.display = v ? 'block' : 'none';
}

export function setThrottle(v: number) {
  ctl.thr = clamp(v, 0, 1);
  $('throttleFill').style.height = `${ctl.thr * 100}%`;
}
