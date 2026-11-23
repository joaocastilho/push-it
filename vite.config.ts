import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: ['es2022', 'safari16'],
    outDir: 'dist',
  },
});
