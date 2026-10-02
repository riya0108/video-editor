// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';

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
  // Everything stays statically prerendered (output defaults to "static").
  // This adapter only powers the one on-demand route that needs a real
  // server: src/pages/api/transcribe-source.ts, which shells out to yt-dlp
  // to resolve YouTube/Instagram/TikTok/etc. links — that route opts in
  // itself via `export const prerender = false`. Everything else is
  // unaffected. Deploying this app now requires a persistent Node process
  // (with yt-dlp + ffmpeg on PATH) rather than pure static hosting.
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss(), crossOriginIsolationHeaders],
    optimizeDeps: {
      // kokoro-js bundles Emscripten (espeak-ng wasm) glue code that
      // misbehaves under esbuild's dependency pre-bundling.
      exclude: ["kokoro-js"],
      // @huggingface/transformers is only ever reached through a dynamic
      // `await import()` at runtime (captions, translation, person-cutout,
      // voice cloning, bg removal) and is never imported at the top of any
      // module Vite's cold-start scanner crawls. That lets the scanner miss
      // it entirely, so the *first* runtime request has to trigger an
      // on-the-fly re-optimize — and on this package (huge, WASM-heavy)
      // that on-demand discovery reliably wedges into a permanent
      // "504 Outdated Optimize Dep" instead of completing, breaking every
      // AI feature until `node_modules/.vite` is wiped by hand. Listing it
      // here forces it into the eager cold-start bundle instead.
      //
      // The same failure hit EVERY tool (2026-10): Astro's cold-start scan
      // only pre-bundles react + the line above, so every other browser
      // dependency is discovered at runtime, the first time some page
      // imports it. Each discovery re-optimizes mid-session, which can
      // invalidate deps already handed out — after that, @ffmpeg/* (imported
      // by every tool) answered "504 Outdated Optimize Dep", React islands
      // failed to hydrate, and every upload dropzone was dead HTML until a
      // restart. Listing ALL browser-side deps makes the optimized set
      // complete at startup, so no page can ever trigger a re-optimize.
      // (Same pre-bundled output as runtime discovery produced — just built
      // up front — so ffmpeg's worker loading is unchanged.)
      // When adding a new browser dependency, add it here too.
      include: [
        "@huggingface/transformers",
        "@ffmpeg/ffmpeg",
        "@ffmpeg/util",
        "lucide-react",
        "onnxruntime-web",
        "@mediapipe/tasks-vision",
        "wavesurfer.js",
        "wavesurfer.js/plugins/regions",
      ],
    },
  },
});
