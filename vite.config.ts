import { defineConfig } from 'vite';

// Der Client liegt in client/, das Build-Ergebnis in dist/ (wird vom Server mit ausgeliefert).
export default defineConfig({
  root: 'client',
  base: './',
  publicDir: 'public',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { host: true, port: 5173, fs: { allow: ['..'] } },
});
