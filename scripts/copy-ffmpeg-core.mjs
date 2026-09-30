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
//
// That smaller pool (hardwareConcurrency+4, e.g. 12 on an 8-core machine)
// later turned out to be too small for its own reason: every `-i` input,
// `-f lavfi` source, and looped image ffmpeg opens claims its own pthread
// regardless of `-threads 1` pinning that input's *codec* parallelism, and
// once total simultaneous inputs/filters exceeds the pool, the on-demand
// pthread request just hangs forever with no error (same failure family as
// the decoder-thread hangs fixed elsewhere in build-editor-command.ts and
// VideoSpeedTool.tsx). Reproduced concretely: the Remove Background tool's
// AI video mode with a "color" replacement background (main video + 1 lavfi
// color source + N per-frame cutout PNGs = 8+ simultaneous inputs) hung
// indefinitely at hardwareConcurrency+4, and completed in ~3s once the pool
// was raised — confirmed empirically before landing this constant, not
// guessed. +16 keeps real parallelism scaling with the machine while giving
// multi-input filter graphs enough headroom; it's well under the 32 that
// caused the original load-time stall.
const corePath = join(dest, "ffmpeg-core.js");
const original = readFileSync(corePath, "utf8");
const patched = original.replace(
  "var pthreadPoolSize=32;",
  "var pthreadPoolSize=Math.max(navigator.hardwareConcurrency||4,4)+16;",
);
if (patched === original) {
  console.warn("[copy-ffmpeg-core] pthreadPoolSize patch target not found — core-mt build may have changed, check manually.");
} else {
  writeFileSync(corePath, patched);
}

console.log("[copy-ffmpeg-core] Copied ffmpeg-core files to public/ffmpeg");
