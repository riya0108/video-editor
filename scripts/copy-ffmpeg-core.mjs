// Copies the self-hosted ffmpeg-core (multithreaded) build into public/ffmpeg
// so it's served same-origin, required for SharedArrayBuffer under COOP/COEP.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
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

console.log("[copy-ffmpeg-core] Copied ffmpeg-core files to public/ffmpeg");
