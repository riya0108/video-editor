// Copies the self-hosted ffmpeg-core (multithreaded) build into public/ffmpeg
// so it's served same-origin, required for SharedArrayBuffer under COOP/COEP.
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "node_modules", "@ffmpeg", "core-mt", "dist", "esm");
const dest = join(__dirname, "..", "public", "ffmpeg");

if (!existsSync(src)) {
  console.warn("[copy-ffmpeg-core] @ffmpeg/core-mt not found, skipping copy.");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"]) {
  copyFileSync(join(src, file), join(dest, file));
}

// @ffmpeg/core-mt hardcodes a pthread pool of 32 workers, eagerly spun up
// (each independently fetching + instantiating the ~32MB wasm module) before
// the very first ffmpeg command can run. Found via testing that one of those
// 32 concurrent same-blob-URL fetches can stall forever, hanging the whole
// engine load with no error — not just wasteful, but a real reliability bug.
// Patch the pool down to a small, still-genuinely-parallel size.
const corePath = join(dest, "ffmpeg-core.js");
const original = readFileSync(corePath, "utf8");
const patched = original.replace(
  "var pthreadPoolSize=32;",
  "var pthreadPoolSize=Math.max(navigator.hardwareConcurrency||4,4)+4;",
);
if (patched === original) {
  console.warn("[copy-ffmpeg-core] pthreadPoolSize patch target not found — core-mt build may have changed, check manually.");
} else {
  writeFileSync(corePath, patched);
}

console.log("[copy-ffmpeg-core] Copied ffmpeg-core files to public/ffmpeg");
