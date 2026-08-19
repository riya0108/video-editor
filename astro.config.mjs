// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

/** @type {import('vite').Plugin} */
// Cross-origin isolation is required for @ffmpeg/core-mt (SharedArrayBuffer).
// Dev only — `astro preview`'s static file server bypasses Vite entirely, so
// production hosting headers (public/_headers, vercel.json) and the custom
// `npm run preview` script (scripts/preview-server.mjs) cover those cases.
const crossOriginIsolationHeaders = {
  name: 'cross-origin-isolation-headers',
  configureServer(server) {
    server.middlewares.use((/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss(), crossOriginIsolationHeaders],
    optimizeDeps: {
      // kokoro-js bundles Emscripten (espeak-ng wasm) glue code that
      // misbehaves under esbuild's dependency pre-bundling.
      exclude: ["kokoro-js"],
    },
  },
});
