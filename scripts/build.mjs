// Baut Client und Server nach release/. Auf dem Tablet (Termux) ist kein Build noetig:
// release/ liegt fertig im Repository, dort reicht "node release/server.mjs".
//   node scripts/build.mjs           einmal bauen
//   node scripts/build.mjs --watch   bei Aenderungen neu bauen und den Server neu starten
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'release';

fs.rmSync(`${out}/public`, { recursive: true, force: true });
fs.mkdirSync(`${out}/public`, { recursive: true });
fs.cpSync('client/public', `${out}/public`, { recursive: true });
const html = fs
  .readFileSync('client/index.html', 'utf8')
  .replace('<script type="module" src="./src/main.ts"></script>', '<script type="module" src="./main.js"></script>');
fs.writeFileSync(`${out}/public/index.html`, html);

const common = { bundle: true, minify: !watch, sourcemap: watch ? 'inline' : false, logLevel: 'info', legalComments: 'none' };
const client = {
  ...common,
  entryPoints: ['client/src/main.ts'],
  format: 'esm',
  target: 'es2020',
  outfile: `${out}/public/main.js`,
};
const server = {
  ...common,
  entryPoints: ['server/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: `${out}/server.mjs`,
  external: ['bufferutil', 'utf-8-validate'], // optionale Beschleuniger von ws
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

if (!watch) {
  await Promise.all([build(client), build(server)]);
} else {
  const [c, s] = await Promise.all([context(client), context(server)]);
  await Promise.all([c.watch(), s.watch()]);
  console.log('Beobachte Aenderungen, Server startet bei jedem Build neu ...');
  spawn(process.execPath, ['--watch', `${out}/server.mjs`], { stdio: 'inherit' });
}
