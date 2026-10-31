// Rauchtest: startet zwei Bots gegen einen laufenden Server (npm start) und prueft die Kernfunktionen.
// Aufruf: npm run smoke   (Server muss auf ws://localhost:8080 laufen, Raumcode "freunde")
import WebSocket from 'ws';
import { buildMap } from '../shared/map';

const URL = process.env.URL ?? 'ws://localhost:8080';
const ROOM = process.env.ROOM ?? 'freunde';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' - ' + extra : ''}`);
  if (!ok) failed++;
};

class Bot {
  ws!: WebSocket;
  id = 0;
  snap: any = null;
  seq = 0;
  events: any[] = [];
  msgs: string[] = [];
  err = '';
  constructor(public name: string) {}
  async join(room = ROOM) {
    this.ws = new WebSocket(URL);
    await new Promise<void>((res, rej) => {
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
    });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'w') this.id = m.id;
      else if (m.t === 's') {
        this.snap = m;
        this.events.push(...m.ev);
      } else if (m.t === 'msg') this.msgs.push(m.text);
      else if (m.t === 'err') this.err = m.text;
    });
    this.send({ t: 'join', name: this.name, room });
    await sleep(300);
  }
  send(m: any) {
    this.ws.send(JSON.stringify(m));
  }
  // schickt n Eingaben im 30-Hz-Takt
  async drive(n: number, mx: number, mz: number, yaw: number, thr = 0) {
    for (let i = 0; i < n; i++) {
      this.send({ t: 'in', seq: ++this.seq, mx, mz, yaw, thr });
      await sleep(1000 / 30);
    }
    await sleep(80);
  }
  me() {
    return this.snap.pl.find((p: any) => p.i === this.id);
  }
  veh() {
    return this.snap.ve.find((v: any) => v.o === this.id);
  }
}

async function main() {
  // Raumcode
  const bad = new Bot('Falsch');
  await bad.join('quatsch');
  check('falscher Raumcode wird abgelehnt', bad.err === 'Falscher Raumcode', bad.err);

  const a = new Bot('Alice');
  const b = new Bot('Bob');
  await a.join();
  await b.join();
  await sleep(3000); // Spawn-Schutz (2,5 s) abwarten
  check('beide Bots verbunden', !!a.snap && !!b.snap && a.snap.pl.length === 2);

  // Laufen
  const z0 = a.snap.you.z;
  await a.drive(30, 0, 1, 0);
  check('Laufen nach vorn (-z)', a.snap.you.z < z0 - 3, `z ${z0} -> ${a.snap.you.z}`);
  check('Server bestaetigt Eingaben (ack)', a.snap.ack === a.seq, `ack ${a.snap.ack} seq ${a.seq}`);

  // Schiessen: Alice zielt auf Bob (Pistole, 4 Treffer)
  await sleep(500);
  await a.drive(2, 0, 0, 0);
  // Falls Alice noch im Flugzeug sitzt, abbrechen
  const aim = () => {
    const me = a.me();
    const t = b.me();
    const dx = t.x - me.x;
    const dz = t.z - me.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(-0.5, Math.hypot(dx, dz));
    return { yaw, pitch, d: Math.hypot(dx, dz) };
  };
  if (a.snap.veh === 0 && a.snap.hp > 0 && b.snap.hp > 0) {
    const { yaw, d } = aim();
    await a.drive(2, 0, 0, yaw);
    for (let i = 0; i < 7; i++) {
      const s = aim();
      a.send({ t: 'f', yaw: s.yaw, pitch: s.pitch });
      await sleep(400);
    }
    await sleep(150);
    const killEv = a.events.find((e) => e.k === 'kill' && e.b === 'Bob');
    if (!killEv) {
      const A = a.me();
      const B = b.me();
      const walls = buildMap().filter((bx) => {
        // grober Test: liegt ein Gebaeude-Mittelpunkt nahe der Strecke A-B?
        const t = Math.max(0, Math.min(1, ((bx.x - A.x) * (B.x - A.x) + (bx.z - A.z) * (B.z - A.z)) / (Math.hypot(B.x - A.x, B.z - A.z) ** 2 || 1)));
        return Math.hypot(A.x + (B.x - A.x) * t - bx.x, A.z + (B.z - A.z) * t - bx.z) < Math.max(bx.hw, bx.hd) + 1;
      });
      console.log('DEBUG A', JSON.stringify(A), 'B', JSON.stringify(B), 'Waende auf Strecke:', walls.length, 'Alice hp', a.snap.hp, 'veh', a.snap.veh, 'waffe', a.snap.wn, 'Schuesse', a.events.filter((e) => e.k === 'shot' && e.by === a.id).map((e) => `${e.hit}@${Math.hypot(e.b[0] - e.a[0], e.b[2] - e.a[2]).toFixed(0)}`).join(' '));
    }
    check('Bob wurde erschossen', !!killEv, `Abstand ${d.toFixed(0)} m, Bob hp ${b.snap.hp}, Kills ${a.me().k}`);
    check('Kill im Scoreboard', a.me().k === 1);
    await sleep(4300);
    check('Bob respawnt', b.snap.hp === 100, `hp ${b.snap.hp}`);
  } else {
    console.log('SKIP Schiessen (Alice sitzt noch im Fahrzeug oder ist tot)');
  }

  // Rakete
  b.events.length = 0;
  a.events.length = 0;
  a.send({ t: 'weapon', i: 2 });
  await sleep(150);
  if (a.snap.veh === 0 && a.snap.hp > 0) {
    a.send({ t: 'f', yaw: aim().yaw, pitch: -0.3 });
    await sleep(2500);
    check('Rakete explodiert', a.events.some((e) => e.k === 'boom'));
  }

  // Auto spawnen, einsteigen, fahren, aussteigen
  a.send({ t: 'spawn', kind: 'car' });
  await sleep(200);
  const car = a.veh();
  check('Auto gespawnt', !!car && car.k === 1);
  const dist = Math.hypot(car.x - a.me().x, car.z - a.me().z);
  a.send({ t: 'enter' });
  await sleep(200);
  check('eingestiegen', a.snap.veh === car.i, `Abstand ${dist.toFixed(1)} m`);
  const cx0 = a.veh().x;
  const cz0 = a.veh().z;
  await a.drive(60, 0, 1, 0);
  const moved = Math.hypot(a.veh().x - cx0, a.veh().z - cz0);
  check('Auto faehrt', moved > 8 && a.snap.you.speed > 5, `${moved.toFixed(1)} m, ${a.snap.you.speed} m/s`);
  await a.drive(60, 0, -1, 0);
  a.send({ t: 'enter' });
  await sleep(200);
  check('ausgestiegen', a.snap.veh === 0, `Tempo ${a.snap.you.speed}`);

  // Flugzeug: spawnen, einsteigen, Vollgas, abheben
  a.msgs.length = 0;
  // erst zur Platzmitte laufen, damit das Auto nicht das naechste Fahrzeug ist
  {
    const me = a.me();
    const yawToCenter = Math.atan2(me.x, me.z);
    await a.drive(70, 0, 1, yawToCenter);
  }
  await sleep(2600); // Spawn-Cooldown
  a.send({ t: 'spawn', kind: 'plane' });
  await sleep(200);
  const pl = a.veh() && a.snap.ve.find((v: any) => v.o === a.id && v.k === 2);
  check('Flugzeug gespawnt', !!pl, a.msgs.join(' '));
  if (pl) {
    // Spieler muss neben das Flugzeug (es kann am Flugplatz stehen), also nur testen wenn nah
    const near = Math.hypot(pl.x - a.me().x, pl.z - a.me().z) < 11;
    if (near) {
      a.send({ t: 'enter' });
      await sleep(200);
      await a.drive(45, 0, 0, 0, 1); // Vollgas, Anlauf
      await a.drive(25, 0, 1, 0, 1); // ziehen
      const v = a.snap.ve.find((x: any) => x.o === a.id && x.k === 2);
      check('Flugzeug hebt ab', !v ? false : v.y > 1.5, v ? `y=${v.y} speed=${a.snap.you.speed}` : 'Flugzeug zerstoert');
    } else {
      console.log(`SKIP Flug (Flugzeug steht ${Math.hypot(pl.x - a.me().x, pl.z - a.me().z).toFixed(0)} m entfernt)`);
    }
  }

  // Aufraeumen
  a.ws.close();
  b.ws.close();
  await sleep(200);
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
