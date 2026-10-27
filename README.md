# Clipbench

A free video and audio editor that runs entirely in the browser. Files are processed on the user's device, never uploaded.

- **Clipbench Studio** (`/tools/video/video-editor`) — a full-screen multi-track editor: timeline, text and animated titles, captions with animated templates, stickers, shapes, keyframes and motion presets, effects, transitions, masks, background removal and swap, brand kit, stock media, transcript-based editing, long-video-to-shorts, Clean Audio, vocal/music separation, auto-ducking, beat sync, and export to MP4/MOV/WebM (up to 4K 60 fps), GIF, WAV and PNG.
- **30+ single-purpose tools** (`/tools`) — trim, merge, crop, resize, speed, remove logo or passer-by, upscale, record screen/camera/voice, text to speech, transcribe and more.

## Requirements

- Node **22.12+**
- A recent Chromium-based browser for the editor (WebCodecs, OffscreenCanvas; WebGPU optional)
- For link transcription (`/api/transcribe-source`): `yt-dlp` and `ffmpeg` on the server's `PATH`

## Setup

```bash
npm install
cp .env.example .env   # optional — see "Configuration"
```

`npm install` also copies the FFmpeg core (and its license notices) into `public/ffmpeg/` and builds the caption font.

## Develop

```bash
astro dev --background   # start the dev server (stop / status / logs: astro dev stop|status|logs)
npm test                 # unit tests (Vitest)
npx astro check          # type-check .astro files
```

The dev server sets the cross-origin isolation headers the editor needs.

## Build and run in production

```bash
npm run build
npm start                # serves dist/ with security headers on PORT (default 4321)
```

`npm start` runs [`server.mjs`](server.mjs), which wraps Astro's Node handler and adds the headers every response needs:

- **Cross-origin isolation** (COOP/COEP/CORP). It's required for multithreaded FFmpeg and AI models; without it they run single-threaded and several times slower.
- **Content-Security-Policy**, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS when served over HTTPS.

`npm run preview` runs the same server. Behind a reverse proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=true` so rate limits apply per real client.

Static hosts (Netlify, Cloudflare Pages, Vercel) get the same headers from `public/_headers` and `vercel.json`. They can't run the `/api` routes, though, so the stock library and link transcription need the Node server.

## Configuration

All optional; see [`.env.example`](.env.example).

| Variable | What it does |
|---|---|
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Enable Pexels / Pixabay in the Studio's stock library (free keys). Openverse works without a key. |
| `STOCK_PROXY_SECRET` | Signs stock download links; set it when running more than one server instance. |
| `PUBLIC_ALLOW_NONCOMMERCIAL_MODELS` | Turns on features whose AI models are licensed for **non-commercial use only** (caption translation, voice cloning, RMBG-1.4). Leave it off for any commercial deployment. |
| `TRUST_PROXY` | Use `X-Forwarded-For` for rate limiting (only behind a proxy that overwrites it). |
| `PORT`, `HOST` | Where `npm start` listens. |

## Licensing

- Third-party notices are published at `/licenses` ([source](src/pages/licenses.astro)), and model provenance is in [MODEL_LICENSES.md](MODEL_LICENSES.md).
- The FFmpeg core is **GPL-2.0-or-later**. It ships with its license, a source and modification notice, and a written offer (`public/ffmpeg/`). Before launching, put a real contact address in [`licenses/FFMPEG_CORE_SOURCE.txt`](licenses/FFMPEG_CORE_SOURCE.txt) and get a legal review.

## Project layout

```text
src/
  pages/                 routes (tools, licenses) and /api routes (stock search, stock files, link transcription)
  components/tool/       the tools; video/studio/ is Clipbench Studio
  lib/                   engines: timeline, composition, render, export, audio, captions, ai, matting,
                         transcript, stock, brand, project (save/autosave/recovery)
public/models/           self-hosted AI models (with license files)
server.mjs               production server
```

The engines are documented in the `*_ARCHITECTURE.md` files at the repo root (for example [TIMELINE_ARCHITECTURE.md](TIMELINE_ARCHITECTURE.md) and [EXPORT_ARCHITECTURE.md](EXPORT_ARCHITECTURE.md)), and open issues are in [FINAL_KNOWN_ISSUES.md](FINAL_KNOWN_ISSUES.md).

## Tests

```bash
npm test
```

Some evaluations use real models or encoders and are skipped unless their inputs are provided. For example, the stem separation check (`src/lib/audio/stems.eval.test.ts`) needs `STEMS_MODEL_DIR` and `STEMS_SPEECH`; see the file for details.
