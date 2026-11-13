// Rauchtest (Stadtkampf): startet zwei Bots gegen einen laufenden Server (npm start) und prueft die Kernfunktionen.
// Aufruf: npm run smoke   (Server muss auf ws://localhost:8080 laufen, Raumcode "freunde")
import WebSocket from 'ws';
import { buildMap, PICKUPS, WORLD } from '../shared/map';

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
  async drive(n: number, mx: number, mz: number, yaw: number) {
    for (let i = 0; i < n; i++) {
      this.send({ t: 'in', seq: ++this.seq, mx, mz, yaw });
      await sleep(1000 / 30);
    }
    await sleep(80);
  }
  me() {
    return this.snap.pl.find((p: any) => p.i === this.id);
  }
}

const boxes = buildMap(1337);
// freie Sicht zwischen zwei Punkten (keine Gebaeude auf der Strecke)?
function clearLine(ax: number, az: number, bx: number, bz: number) {
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const z = az + ((bz - az) * i) / n;
    if (boxes.some((b) => Math.abs(x - b.x) < b.hw && Math.abs(z - b.z) < b.hd)) return false;
  }
  return true;
}

async function main() {
  // Raumcode
  const bad = new Bot('Falsch');
  await bad.join('quatsch');
  check('falscher Raumcode wird abgelehnt', bad.err === 'Falscher Raumcode', bad.err);

  let a = new Bot('Alice');
  let b = new Bot('Bob');
  await a.join();
  await b.join();
  check('beide Bots verbunden', !!a.snap && !!b.snap && a.snap.pl.length === 2);
  check('Start: Pistole mit vollem Magazin', a.snap.wi === 0 && a.snap.am === 12 && a.snap.rs === -1, `${a.snap.wn} ${a.snap.am}/${a.snap.rs}`);
  check('Runde laeuft', a.snap.rd.s === 0 && a.snap.rd.t > 0, JSON.stringify(a.snap.rd));
  check('Gegenstaende gemeldet', Array.isArray(a.snap.pk) && a.snap.pk.length === PICKUPS.length);

  // Laufen
  const z0 = a.snap.you.z;
  await a.drive(30, 0, 1, 0);
  check('Laufen nach vorn (-z)', a.snap.you.z < z0 - 3 || a.snap.you.z <= -WORLD + 2, `z ${z0} -> ${a.snap.you.z}`);
  check('Server bestaetigt Eingaben (ack)', a.snap.ack === a.seq, `ack ${a.snap.ack} seq ${a.seq}`);

  // Beide solange neu verbinden, bis sie freie Sicht aufeinander haben (zufaellige Spawnpunkte)
  for (let i = 0; i < 80; i++) {
    const A = a.me();
    const B = b.me();
    const d = Math.hypot(A.x - B.x, A.z - B.z);
    if (process.env.DBG) console.log(i, d.toFixed(0), clearLine(A.x, A.z, B.x, B.z));
    if (clearLine(A.x, A.z, B.x, B.z) && d < 70 && d > 5) break;
    a.ws.close();
    b.ws.close();
    await sleep(120);
    a = new Bot('Alice');
    b = new Bot('Bob');
    await a.join();
    await b.join();
  }
  await sleep(2800); // Spawnschutz abwarten
  const aim = () => {
    const me = a.me();
    const t = b.me();
    const dx = t.x - me.x;
    const dz = t.z - me.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(-0.55, Math.hypot(dx, dz)), d: Math.hypot(dx, dz) };
  };
  await a.drive(2, 0, 0, aim().yaw);
  // Pistole: ein Magazin leeren muss nachladen ausloesen, 5 Treffer toeten
  for (let i = 0; i < 12 && b.snap.hp > 0; i++) {
    const s = aim();
    a.send({ t: 'f', yaw: s.yaw, pitch: s.pitch });
    await sleep(340);
  }
  await sleep(250);
  const killEv = a.events.find((e) => e.k === 'kill' && e.b === 'Bob');
  const hits = a.events.filter((e) => e.k === 'hit' && e.by === a.id).length;
  check('Treffer-Ereignisse', hits >= 3, `${hits} Treffer`);
  check('Bob wurde erschossen', !!killEv, `Abstand ${aim().d.toFixed(0)} m, Bob hp ${b.snap.hp}`);
  check('Kill im Scoreboard', a.me().k >= 1, `Kills ${a.me().k}`);
  await sleep(3500);
  check('Bob respawnt voll', b.snap.hp === 100, `hp ${b.snap.hp}`);
  check('Waffe nach Respawn: nur Pistole', b.snap.ow.join() === '1,0,0');

  // Nachladen: Magazin leer schiessen -> automatisches Nachladen, danach wieder voll
  const am0 = a.snap.am;
  a.send({ t: 'f', yaw: 0, pitch: 0.5 });
  await sleep(500);
  check('Schuss verbraucht Munition', a.snap.am === am0 - 1 || a.snap.rl > 0, `${am0} -> ${a.snap.am}`);
  a.send({ t: 'reload' });
  await sleep(200);
  check('Nachladen startet', a.snap.rl > 0 || a.snap.am === 12, `rl ${a.snap.rl}`);
  await sleep(1700);
  check('Magazin wieder voll', a.snap.am === 12, `am ${a.snap.am}`);

  // Waffe ohne Besitz laesst sich nicht waehlen
  a.send({ t: 'weapon', i: 2 });
  await sleep(150);
  check('RPG ohne Pickup nicht waehlbar', a.snap.wi === 0);

  // Rundenende: mit KILL_LIMIT=1 beendet der erste Kill die Runde
  if (process.env.EXPECT_ROUND_END) {
    const win = a.events.find((e) => e.k === 'win');
    check('Rundenende gemeldet', !!win && win.n === 'Alice', JSON.stringify(win));
    check('Rangliste-Phase aktiv', a.snap.rd.s === 1);
    await sleep(10600);
    check('Neue Runde, Kills zurueckgesetzt', a.snap.rd.s === 0 && a.me().k === 0, JSON.stringify(a.snap.rd));
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
