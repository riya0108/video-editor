// ffmpeg's drawtext filter needs a real .ttf/.otf it can hand to freetype.
// We already ship these as woff2 for the UI; woff2 is a lossless compressed
// wrapper around the same sfnt font data, so we decompress our existing
// (OFL-licensed) font files back into .ttf for drawtext to use, instead of
// bundling separate copies.
import { decompress } from "wawoff2";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(__dirname, "..", "node_modules");
const destDir = join(__dirname, "..", "public", "fonts");
mkdirSync(destDir, { recursive: true });

const FONTS = [
  {
    src: join(nodeModules, "@fontsource-variable", "geist", "files", "geist-latin-wght-normal.woff2"),
    dest: join(destDir, "geist-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource-variable", "geist-mono", "files", "geist-mono-latin-wght-normal.woff2"),
    dest: join(destDir, "geist-mono-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "bebas-neue", "files", "bebas-neue-latin-400-normal.woff2"),
    dest: join(destDir, "bebas-neue-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "anton", "files", "anton-latin-400-normal.woff2"),
    dest: join(destDir, "anton-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "poppins", "files", "poppins-latin-700-normal.woff2"),
    dest: join(destDir, "poppins-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "playfair-display", "files", "playfair-display-latin-700-normal.woff2"),
    dest: join(destDir, "playfair-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "caveat", "files", "caveat-latin-700-normal.woff2"),
    dest: join(destDir, "caveat-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "oswald", "files", "oswald-latin-600-normal.woff2"),
    dest: join(destDir, "oswald-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "permanent-marker", "files", "permanent-marker-latin-400-normal.woff2"),
    dest: join(destDir, "permanent-marker-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "archivo-black", "files", "archivo-black-latin-400-normal.woff2"),
    dest: join(destDir, "archivo-black-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "bangers", "files", "bangers-latin-400-normal.woff2"),
    dest: join(destDir, "bangers-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "pacifico", "files", "pacifico-latin-400-normal.woff2"),
    dest: join(destDir, "pacifico-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "righteous", "files", "righteous-latin-400-normal.woff2"),
    dest: join(destDir, "righteous-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "bungee", "files", "bungee-latin-400-normal.woff2"),
    dest: join(destDir, "bungee-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "dancing-script", "files", "dancing-script-latin-700-normal.woff2"),
    dest: join(destDir, "dancing-script-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "roboto-slab", "files", "roboto-slab-latin-700-normal.woff2"),
    dest: join(destDir, "roboto-slab-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "montserrat", "files", "montserrat-latin-700-normal.woff2"),
    dest: join(destDir, "montserrat-drawtext.ttf"),
  },
  {
    src: join(nodeModules, "@fontsource", "great-vibes", "files", "great-vibes-latin-400-normal.woff2"),
    dest: join(destDir, "great-vibes-drawtext.ttf"),
  },
];

for (const { src, dest } of FONTS) {
  const woff2 = readFileSync(src);
  const ttf = await decompress(woff2);
  writeFileSync(dest, ttf);
  console.log(`[build-drawtext-font] Wrote ${dest} (${ttf.length} bytes)`);
}
