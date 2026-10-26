# Final Known Issues — RC2

**Severity:**
- **P0** — critical: crash, data loss, security compromise, or a core workflow impossible.
- **P1** — major: a common workflow broken or misleading; release-blocking unless accepted.
- **P2** — moderate: degraded, with a workaround.
- **P3** — minor.

**Status:** **Fixed** = fixed and verified in Phases 19–20. **Open** = shipping as-is in RC2.

## Open

### P0

None.

### P1 — major (release gates G11, G12; P1-3 accepted)

| ID | Issue | Impact | Workaround | Fix direction |
|---|---|---|---|---|
| **P1-3** | Audio files over 30 minutes are refused (clear message) | Full podcast episodes need splitting first | Split the file | Streaming / windowed audio decode (new functionality) |
| **P1-4** | The production Node server sends **no COOP/COEP** and no security headers (CSP, nosniff, Referrer-Policy) | Not cross-origin isolated: in the editor, background removal and AI models run single-threaded (bg removal 10.8 s vs 3.2 s); the site's multithreaded ffmpeg.wasm tools need isolation; no defense-in-depth headers | Serve behind a proxy that adds the headers | Deployment configuration (the Node adapter serves static files without middleware) |
| **P1-5** | Licensing: `@ffmpeg/core-mt` (**GPL-2.0+**, libx264 build) is distributed to browsers; **RMBG-1.4 (non-commercial)** powers non-editor tools | Legal exposure for any commercial release of the site. The editor itself uses only Apache/MIT/BSD models and doesn't load ffmpeg.wasm | Non-commercial use only, or don't ship those tools | Legal review; replace RMBG-1.4 (U²-Net is already integrated) or license it |

### P2 — moderate

| ID | Issue | Notes |
|---|---|---|
| P2-5 | Export memory still scales with **audio** length: the full stereo mix is built before encoding (≈ 23 MB per minute of timeline, transient). A 30-min export peaks at 907 MB; ≈ 2 h would approach 3 GB | Was the whole file (≈ 3.8× its size). Fix direction: mix and encode audio in chunks |
| P2-1 | Full-frame CPU effects make exports slower than realtime: 6 s took 30.7 s; 84 s took 139 s | Correct output. Effects on still images are recomputed every frame; GPU or worker effects are the next step |
| P2-2 | A truncated / damaged video imports without a warning; its picture freezes after the data ends and its soundtrack is reported as "no audio" | Truncated WAVs already get a warning; videos should too |
| P2-4 | `/api/transcribe-source` has no authentication or rate limit; redirects / DNS rebinding to internal hosts can't be blocked in-app (yt-dlp resolves and redirects itself) | Literal / resolved private targets are blocked (fixed). The deployment must deny egress to private ranges and rate-limit |

### P3 — minor

| ID | Issue |
|---|---|
| P3-1 | No "New project" command; a fresh page opens the demo project |
| P3-2 | Multi-file drop stacks the last file frontmost |
| P3-3 | Multiple caption tracks default to the same position and overlap |
| P3-4 | Corrupt-video message blames a codec and shows Chrome internals |
| P3-5 | Dropping `.srt` / `.vtt` on the editor isn't routed to caption import |
| P3-6 | Engine API edges not reachable from the UI (partial text style stored un-normalized; `trimClip` end before start clamps to 1 frame) |
| P3-7 | Project frame rate fixed at 30 fps (export resamples to 24–60) |
| P3-8 | Large projects (600 clips) in the development build: playback 49 fps with long tasks |
| P3-9 | 7 npm advisories (3 high, 4 moderate) in Node-only optional deps of `kokoro-js` → `transformers@3` (`sharp@0.34.5`, `onnxruntime-node`, `adm-zip`, …). No upstream fix; not reachable in the browser bundle or the server |
| P3-10 | SVG markup loaded from a project file isn't re-sanitized (contained: rendered only as `<img>`) |
| P3-11 | VP8 + alpha WebM export is slow (22.9 s vs ~2 s for VP9 alpha on the same case) |

## Fixed (Phases 19–20)

| ID | Was | Fix |
|---|---|---|
| **P1-1** (RC2) | Exports using the built-in **Dissolve** transition were reported FAILED (fidelity 21.7 dB < 30) | Fidelity is now judged **relative to the neighbouring frames**: a checkpoint below 30 dB passes only if it is ≥ 20 dB **and** matches its own render at least as well as the renders of frames k±1, with ≥ half of all checkpoints still ≥ 30 dB. Codec-limited detail (dither, grain) passes; shifted, black or garbage frames, and global problems, still fail. Project 7 now validates. 6 unit tests |
| **P1-2** (RC2) | Exports held entirely in memory (10 min 1080p: 2.3 GB peak heap; ≈ 30 min would crash the tab) | (1) The output is **streamed to a private file** (Origin Private File System) instead of RAM; MP4/MOV keep Fast Start via Mediabunny `'reserve'`. (2) **Audio is encoded before video**, so the muxer no longer holds every video packet for interleaving. (3) Validation keeps only the 1 s of audio the sync check reads, with identical results. Files are deleted when the job is removed; leftovers are swept at the next export. **10 min: 2.3 GB → 555 MB peak. 30 min (1.7 GB file): valid, 907 MB peak**, flat during video. 3 unit tests + 19 export cases re-checked by ffmpeg |
| P0 | WebM videos imported as audio, or rejected | `refineImportKind` probes ambiguous containers |
| P0 (security) | Astro ≤ 7.2.7 RCE via `/_image` (exposed by the Node server) + base-path auth bypass | Astro 7.3.8 |
| P1 (security) | SSRF guard bypassable (`[::ffff:169.254.169.254]`, `localtest.me`, `0.x`, …) | `lib/net/public-url.ts` with DNS resolution |
| P2 | Export ~15× slower past the end of a truncated video (Phase 18 regression) | Cursor holds the last frame |
| P2 | `npm run preview` returned 500 | Serves `dist/client` |
| P3 | SVG sanitizer kept unquoted `javascript:` hrefs | Unquoted values handled |
| — | 10 more advisories (svgo, devalue, undici, …) | `npm audit fix` (semver-compatible) |

## Fixed after RC2

| ID | Was | Fix |
|---|---|---|
| P1 | Every ONNX tool on the WASM backend (background removal / U²-Net, upscale, TTS) hung forever at "loading model" in the Claude desktop app's built-in browser (Electron Chromium 152). Real Chrome 156 was not affected | **Cause:** `ort.env.wasm.proxy = true` runs ORT inside a proxy worker, and the multi-threaded build then starts its pthread pool with `new Worker(import.meta.url)` from *inside* that worker. That Chromium can't start a nested worker from an http(s) URL (blob: URLs work). The nested worker fires `error`, Emscripten never listens for it, and `InferenceSession.create` waits on the pool forever. Same in `astro dev` and the production build, so neither Vite nor the CDN was involved. **Fix** (`src/lib/ml/onnx-runtime.ts`): the Emscripten glue (`ort-wasm-simd-threaded.jsep.mjs`, self-hosted via Vite `?url`) is fetched once and passed to ORT as a blob: URL in `env.wasm.wasmPaths`, so its pthread workers start from a blob: URL too. Proxied creation of u2netp now takes about 0.2 s with 8 threads. Also fixed in the same helper: (1) all creates, `run()` and `release()` calls go through one queue, because the WASM backend rejects overlapping calls ("Session already started"); (2) the proxy mode is fixed by the first session, because ORT initializes only once and switching `proxy` afterwards sends calls to a runtime that was never started. If the runtime is proxied, a later WebGPU request runs on WASM instead, or is refused with a "reload" message for fp16 models; (3) creation has a 120 s timeout with a clear error instead of spinning forever |
