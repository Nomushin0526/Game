import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022' },
  // Rapier ships inlined base64 wasm in the `-compat` build, so no wasm plugin is needed.
  optimizeDeps: { exclude: [] },
});
