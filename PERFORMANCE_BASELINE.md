# Performance Baseline — Phase 18

Measured **before** any Phase 18 optimization, on the code at `71e539a`. Every number below comes from a real run.
Where a metric could not be measured, this document says so and does not estimate it.

## 1. Machine and method

| | |
|---|---|
| Hardware | 8-core Intel Mac, 8 GB (`navigator.deviceMemory`), Apple Metal 3 WebGPU adapter |
| Browser | Chrome 154, `crossOriginIsolated: true`, devicePixelRatio 1 |
| Server | `astro dev` (Vite, React development build), except §3.1 (production build) |
| Harness | `src/lib/perf/perf-harness.ts`, run in the page through chrome-devtools: `await import('/src/lib/perf/perf-harness.ts')` |

The harness only **times** production code paths: `MediaFrameProvider`, `PreviewRenderer`, `FinalRenderer`,
`AudioSourceStore` and `renderTimeline`. It reimplements nothing.

**Noise.** This machine throttles thermally under sustained load. The same build measured back to back varied by up to
±50 % on some runs (§3.4 of the report). Before/after comparisons of compositing were therefore taken as **interleaved
A/B runs**: old, new, old, new, with the files swapped and the page reloaded between runs. Single numbers here are
p50s of 15–60 samples.

### Benchmark project

`src/lib/perf/bench-project.ts`: 1920×1080, 30 fps, 300 frames (10 s). It is deliberately busy:

| Layer | What it exercises |
|---|---|
| Main video | 1080p H.264, split at 5 s with a 0.5 s cross-dissolve: two decoders during the dissolve |
| PiP video | The same source, 20 s later; scale 0.4; brightness effect; feathered ellipse mask. Uses the isolated path |
| Logo | Still image with screen blend |
| Lower third | Rounded rectangle with a blur effect (spatial kernel) |
| Badge | Ellipse with keyframed x |
| Title | Text with stroke and shadow |
| Caption | Caption-track text |
| Music | The video's soundtrack on an audio track |

### Media

Generated with ffmpeg into `.tmp-test-assets/phase18/`:

- `bench-1080p30-60s.mp4`: 1920×1080, 30 fps, 60 s, H.264 High with B-frames, GOP 2 s, 8 Mbit/s, AAC 128k, 58 MB
- `bench-4k30-20s.mp4`: 3840×2160, 30 fps, 20 s, 30 Mbit/s, no audio, 72 MB

## 2. Results

### 2.1 Startup (production build)

`astro build`. The JavaScript the editor page (`/tools/video/composition-preview`) imports statically before it is
interactive, found by walking the import graph from the island's entry chunks:

| | Files | Raw | gzip |
|---|---|---|---|
| Startup JS | 46 | 669 KB | 213 KB |
| Largest chunks | — | `CompositionPlaygroundPanel` 375 KB · React client 180 KB · `settings` 85 KB | |
| CSS | 1 | 122 KB | 28 KB |

ML runtimes (onnxruntime wasm 21–25 MB each, kokoro 2.1 MB, transformers 540 KB) are all loaded lazily, not at startup.

In-browser timings (production build, local static server with COOP/COEP; "interactive" = the editor island has
hydrated and its Play button exists):

| Load | FCP | DOMContentLoaded | Interactive |
|---|---|---|---|
| Cold (first visit to the origin) | 991 ms | 687 ms | 1037 ms |
| Warm | 152 ms | 125 ms | 222 ms |

### 2.2 Project load

Measured after the browser session was restored, through the editor's own `manager.openFile`. The test project is
`phase17/persistence-test.clipbench`: 286 KB, 13 clips, 7 assets (2 videos, 3 generated stills, 1 image, 1 audio).

| Open | Load time | Time to painted |
|---|---|---|
| Cold | 327 ms | 352 ms |
| Warm | 49–92 ms | 67–110 ms |

All assets loaded OK. Phase 18's only change to this path is passing the file blob to `addVideo`, which does no work
until an export starts. So this is effectively the baseline, and project load is **not a bottleneck**.

### 2.3 Media import (what dropping a file does: `addMediaFiles`)

| File | Metadata | Fingerprint | Clip on timeline | Soundtrack decoded | Long tasks |
|---|---|---|---|---|---|
| 1080p 60 s, 58 MB | 22.1 ms | 6.7 ms | **28.8 ms** | 100.7 ms (60 s AAC) | 0 |
| 4K 20 s, 72 MB | 10.8 ms | 5.7 ms | **16.5 ms** | — (no audio track) | 0 |

The fingerprint reads only the file's head and tail, so it doesn't grow with file size. The soundtrack decode runs in
the background and doesn't block the clip.

### 2.4 Timeline scrubbing (paused preview, ½ quality, 960×540)

| | p50 | p95 |
|---|---|---|
| Random jump: request → exact frame decoded and drawn | 49–51 ms | 75–91 ms |
| Drag (one new frame per animation frame, 120 frames): composite cost | 15.7 ms | 18.4 ms |
| Drag: displayed frame behind the playhead | **12 frames** | 39 frames |
| Drag: distinct frames shown out of 120 requested | **28** | |
| Settle after release | 30 ms | |

Each drag request supersedes the `<video>` seek still in flight, so most seeks never finish.

### 2.5 Preview compositing (paused; all media decoded; frame 10 unless noted)

| Quality | Raster | p50 | p95 |
|---|---|---|---|
| Full | 1920×1080 | **37.5 ms** | 50.3 ms |
| Full, transition frame (150) | 1920×1080 | 49.5 ms | |
| ½ | 960×540 | 12.8 ms | 33.2 ms |

Per-layer cost, measured by removing one layer at a time (full quality, p50):

| Removed | Frame cost | Layer's share |
|---|---|---|
| (none) | 34.9 ms | |
| Lower-third blur effect only | 15.0 ms | **≈ 20 ms** |
| PiP (mask + effect, isolated path) | 18.8 ms | **≈ 16 ms** |
| Main video, logo, badge, title, caption | 34.0–34.8 ms | < 1 ms each |

In Node, on the lower third's 940×180 region, the blur kernel alone took **24.2 ms**: glow 30.2 ms, sharpen 9.0 ms,
brightness 1.0 ms.

### 2.6 Playback

**Harness playback** (benchmark project, provider playing, one render per animation frame, presented to an on-screen
canvas). "Auto" quality resolves to full here (zoom 0.6 × DPR 1 → scale 1).

| Quality | UI fps | Render p50 / p95 | Main thread spent rendering | Decoded fps per video | Long tasks |
|---|---|---|---|---|---|
| Auto (= full) | **22.9** | 43.2 / 57.5 ms | 99.5 % | 20.3 / 22.8 | 10 (587 ms) |
| Full | **19.8** | 45.2 / 72.7 ms | 99.3 % | 18.0 / 19.8 | 26 (1746 ms) |

The 30 fps source cannot be shown at 30 fps: compositing alone exceeds the 33 ms budget.

**Real editor UI** (built-in demo project: backdrop, video, alpha-matted PiP, logo, badge, title):

- 59–60 UI fps, 0 long tasks.
- A 4.9 s devtools trace (`.tmp-test-assets/phase18/trace-editor-playback.json.gz`) shows the main thread **87 % busy**:

| | Inclusive | Share |
|---|---|---|
| Preview render loop | 1973 ms | 40 % |
| `drawImage` (self) | 1538 ms | 31 % |
| React render + commit | 1758 ms | 36 % |
| Ruler drawing (`drawRulers`) | 225 ms | 4.6 % |

  `drawImage` is mostly the isolated PiP: a video drawn into a CPU-backed canvas. React re-renders the whole editor on
  every frame because playback updates the frame state per animation frame. Panels that don't depend on the frame
  re-render too: ProjectBar 135 ms, VideoExportPanel 109 ms, LayersPanel 102 ms, AIPanel 75 ms. About 1.1 s of the
  React time is `console.createTask`/`jsxDEV`, which exists only in the **development** build.

**Production build, same demo playback** (animation-frame callbacks and React's scheduler task timed by wrapping them,
5 s, ×2): 60 fps.

| | Per frame |
|---|---|
| Animation-frame work (preview render + tick) | **8.35 ms** |
| React scheduler work | 0.50–0.58 ms |
| Main thread busy | **53 %** |

React is about 0.5 ms per frame in production, so the per-frame re-render is **not** a production bottleneck. The
preview render is.

### 2.7 Memory

| Point | JS heap | Whole page (`measureUserAgentSpecificMemory`) |
|---|---|---|
| Editor loaded | 47.6 MB | 61.7 MB |
| + benchmark project loaded and composited | 115.8 MB | 75.1 MB |
| + 12 s of playback | 151.6 MB | 177.2 MB |
| After export | 58.8 MB | 186.6 MB |

The export's heap delta was −8.3 MB (GC during the run). Importing a 60 s 1080p video added 11.2 MB of heap; the 60 s
stereo PCM is held for playback.

### 2.8 CPU and GPU

- **CPU:** see the busy percentages and long tasks in §2.6 and §2.10. The main thread is the bottleneck for preview and
  playback.
- **GPU:** no browser API exposes GPU utilisation or memory to the page, so it is **not measured**. What was measured is
  the cost of the GPU/CPU boundary at 1920×1080 (p50, synchronised):

| Operation | Time |
|---|---|
| Video frame → GPU canvas | 1.0 ms |
| Video frame → CPU (`willReadFrequently`) canvas | **4.5 ms** |
| Full CPU canvas → GPU canvas | 0.9 ms |
| Clear CPU canvas | 0.15 ms |
| `getImageData` 780×460 | 0.3 ms |
| `putImageData` 780×460 | 0.4 ms |

### 2.9 Final render (exact frames, sequential, frames 0–59)

| | p50 | p95 |
|---|---|---|
| Per frame | **133 ms** (7.7 fps) | 174 ms |
| Waiting for exact source frames (slowest layer) | **96.7 ms** | 114 ms |
| Resolve + draw | 36.4 ms | |

### 2.10 Export (benchmark project → MP4, 1920×1080 @ 30, H.264 + AAC)

| | |
|---|---|
| Wall time for 10 s | **43.9 s** (0.23× realtime) |
| Video frames/s | 7.4 |
| Validation | ok (all checks pass) |
| Output | 11,851,015 bytes |

Stages (ms):

| setup | frames | checks | encode | audio | finalize | validate |
|---|---|---|---|---|---|---|
| 2480 | **40,174** | 145 | 460 | 93 | 36 | 478 |

Per frame: render 133.9 ms, encode **1.5 ms**, checks 0.5 ms. Encoding already uses the browser's hardware WebCodecs
encoder and is not a bottleneck.

### 2.11 Caches

| Cache | State |
|---|---|
| Waveform peaks | Computed once per source after decode (§2.3) |
| ML models | Cache Storage, verified in Phase 14 (PERFORMANCE.md) |
| Text layout | Cold resolve 1.03 ms → warm 0.01 ms (measured on the post-change tree; the cache code is unchanged) |
| Fonts | First `document.fonts.load` 34.2 ms → 0.05 ms |
| ML models | 1 entry, 4.4 MB in Cache Storage |
| Mask raster (feathered PiP ellipse) | Frame on a cache **miss 105.9 ms**, on a hit 30.6 ms: a miss costs ≈ 75 ms. A keyframed or animated feathered mask misses on **every** frame |
| Video thumbnails | **None exist** — the timeline shows no filmstrips, so there is no thumbnail cache to measure |

## 3. Bottlenecks, ranked by measured cost

1. **Exact-frame decode for export.** About 97 ms of a 134 ms frame. Each frame seeks a `<video>` element, which
   decodes from the previous keyframe, and two clips of one source share that one element and seek back and forth.
2. **Spatial effect kernels.** Blur took 24 ms (glow 30 ms) on a lower-third-sized region: more than half the frame
   budget for one layer.
3. **Isolated-layer path on CPU canvases.** About 16 ms for one masked and effected PiP. Video is drawn into CPU canvases
   (4.5 ms vs 1.0 ms on GPU), plus float conversions and a full-frame upload per isolated layer.
4. **Feathered-mask rasterization on a cache miss.** About 75 ms (46 ms of it in the signed distance field). Every frame
   of an animated feathered mask pays it.
5. **Drag-scrub seek thrash.** 28 of 120 frames shown, lagging 12 frames.

React's per-frame re-render looked large in development (36 %) but is 0.5 ms per frame in production: not a bottleneck.

Encoding (1.5 ms per frame), media import (< 30 ms) and audio decode were measured, and they are not bottlenecks.
