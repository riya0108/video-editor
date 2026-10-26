// PRODUCTION SERVER — `npm start` (and `npm run preview`, so preview mirrors production exactly).
//
// Wraps Astro's Node handler (static files + the on-demand API routes) and adds the headers every response needs:
//   - Cross-origin isolation (COOP/COEP/CORP): required for SharedArrayBuffer, i.e. multithreaded ffmpeg.wasm and
//     multithreaded AI models. Without it they fall back to one thread (background removal ~3x slower).
//   - Defense-in-depth security headers (CSP, nosniff, referrer and permissions policy, HSTS behind HTTPS).
// The Node adapter's own standalone server serves static files without middleware, which is why this wrapper exists.
// Static hosts (Netlify/Cloudflare `public/_headers`, `vercel.json`) carry the same headers — keep them in sync.
//
// Env: PORT (default 4321), HOST (default 0.0.0.0 in production, localhost otherwise).
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

process.env.ASTRO_NODE_AUTOSTART = "disabled";
const { handler } = await import(new URL("./dist/server/entry.mjs", import.meta.url).href);

/**
 * Content-Security-Policy. Scripts: our own bundles, Astro's inline hydration/theme snippets ('unsafe-inline' — Astro
 * emits them without nonces), WebAssembly, blob: workers/modules (the ONNX runtime glue, ffmpeg threads) and the
 * jsDelivr CDN that MediaPipe and Transformers.js load their WASM loaders from. Network: our origin plus HTTPS for
 * model downloads (Hugging Face and its CDNs) — nothing over plain HTTP. No plugins, no framing, no form posts
 * elsewhere.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https: blob: data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Camera / microphone / screen capture are used by the recorder tools on this origin only.
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()",
};

const server = createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  handler(req, res);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4321;
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");
  server.listen(port, host, () => console.log(`Clipbench running at http://${host}:${port} (cross-origin isolated, security headers on)`));
}
