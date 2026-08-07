// `astro preview` serves the static build without going through Vite's plugin
// pipeline, so our COOP/COEP headers (needed by @ffmpeg/core-mt) never get
// applied — the multithreaded ffmpeg engine would silently fail to init.
// This is a minimal static file server for dist/ that always sets them,
// so `npm run preview` actually mirrors production.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = join(__dirname, "..", "dist");
const port = Number(process.env.PORT) || 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain",
};

async function resolveFile(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(root, safePath);

  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(root, safePath, "index.html");
  }

  try {
    await stat(filePath);
    return filePath;
  } catch {
    return join(root, "404.html");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = await resolveFile(url.pathname);

  try {
    const data = await readFile(filePath);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
    res.writeHead(filePath.endsWith("404.html") ? 404 : 200);
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(port, () => {
  console.log(`Preview (with COOP/COEP headers) running at http://localhost:${port}`);
});
