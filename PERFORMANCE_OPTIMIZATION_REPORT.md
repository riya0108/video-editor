# Performance Optimization Report — Phase 18

Baseline: `PERFORMANCE_BASELINE.md` (same machine, harness, benchmark project and media). Only bottlenecks that the
baseline measured were optimized, and each change was measured before it was kept. Three changes that measured no
gain, or a loss, were reverted, and are listed here as well (§7).

Output correctness, per change:

- **Pixel-identical** (proven with byte-exact tests and frame hashes against the original code): optimizations 1, 2, 3
  and 5.
- **Optimization 4** changes pixels in exactly one place: isolated layers are now resampled by the same GPU filter as
  every other layer. This removes a real inconsistency (§5).

## 1. Summary — before / after

| Metric | Before | After | Change |
|---|---|---|---|
| **Export**, 10 s 1080p30 benchmark project | 43.9 s (0.23× realtime) | **11.7 s** (0.85×), of which 2.5 s was one-time setup ¹ | **3.7× faster** |
| Export render throughput | 7.4 frames/s | **34.3 frames/s** | 4.6× |
| Final render per frame (p50) | 133 ms | **25.3 ms** | 5.3× |
| Waiting for exact source frames (p50) | 96.7 ms | 0.5–0.6 ms | ≈ 170× |
| **Playback**, benchmark project, auto quality | 22.9 fps, 10 long tasks | **30.7 fps** (the source's full rate), 0 long tasks | +34 % |
| Playback, benchmark project, ½ quality | — | 60 fps, 0 long tasks | |
| **Playback main thread**, editor demo project, production build | 53 % busy, 8.35 ms per frame | **8.5 % busy, 0.7 ms per frame** | 12× less CPU |
| Preview, full 1080p, frame 10 (p50) | 37.5 ms | 23.2 ms | 1.6× |
| Preview, full 1080p, transition frame 150 (p50) | 49.5 ms | 30.4 ms | 1.6× |
| Preview, ½ quality (p50) | 12.8 ms | 10.2 ms | 1.25× |
| **Drag-scrub**: frames shown out of 120 | 28 | **62–65** | 2.3× |
| Drag-scrub: frames behind playhead (p50 / p95) | 12 / 39 | **3 / 5** | 4× / 8× |
| Random jump to exact frame (p50) | 49–51 ms | 44–48 ms | unchanged (decoder-bound) |
| Feathered-mask miss (frame with a cache miss) | 105.9 ms | **64.3 ms** | −41 ms |
| Blur / glow / sharpen kernels (Node, 940×180) | 24.2 / 30.2 / 9.0 ms | 6.3 / 7.5 / 3.4 ms | 2.7–4× |
| Startup JS, editor page | 669 KB (213 KB gzip) | 673 KB (215 KB gzip) | +4 KB |
| Startup, warm, interactive | 222 ms | 180 ms | same within noise |
| Project load (13 clips, 7 assets) | — | 327 ms cold, 49–92 ms warm | not a bottleneck |
| Unit tests | 1192 | **1204** (+12 new) | all pass |

¹ Export setup (codec probing, output start) took 2.5 s on some first exports in a fresh page, in the baseline too. On
others it took 41 ms. Probing (41 ms) and the encoder-delay measurement (23 ms) are not it. This is a one-time,
intermittent cost: not reproducible on demand, so it was not optimized. Without it, the export takes about 9.2 s.

## 2. Optimization 1 — exact frames: WebCodecs sequential decode (hardware decoding, frame cache)

**Bottleneck** (baseline §2.9). Each final frame did the following:

- seeked a `<video>` element, which decodes from the previous keyframe every time;
- waited for `seeked`;
- raced a `requestVideoFrameCallback` against a 50 ms timeout.

Every clip of one source shared that one exact decoder, so the main clip and a PiP of the same file pulled it back and
forth by 20 s each frame.

**Change.** `src/lib/composition/sequential-frame-cursor.ts` (new) and `media-frame-provider.ts`.

- The final path decodes with WebCodecs through Mediabunny (`VideoSampleSink.samples()`, hardware decode). There is
  one forward-only decoder per on-screen slot (clip id), wrapped in a `SequentialFrameCursor`. The cursor decides:
  - t inside the current frame: return it, no decoding;
  - t up to 2 s ahead: decode forward to it;
  - t behind, or further ahead: restart, and the decoder seeks to the keyframe itself.
- It uses the same frame-selection rule as a seeked `<video>`: the last frame whose start is ≤ t, or the first frame
  if t is before it.
- Each request still resolves with its own snapshot canvas. The AI and matte-generation callers rely on that contract.
- Idle decoders close after 5 s (WebCodecs decoders are a limited hardware resource). `remove()` disposes them.
- **Fallback to the old `<video>` path**, which is unchanged, whenever the decoder can't reproduce what `<video>` shows:
  - no `VideoDecoder`, or the codec can't be decoded;
  - rotation metadata;
  - an alpha-capable track;
  - display size ≠ the `<video>` size;
  - any decode error mid-stream (that source switches permanently).
- `addVideo(…, blob)`: the editor's import and project load pass the `File`/`Blob`, which is read directly.
- Mediabunny is **lazy-loaded** on the first exact request. The first version imported it statically, and the
  production build's startup JS grew from 669 KB to 1,085 KB. That was caught by walking the built import graph, and
  the dynamic import brought startup back to 673 KB. It was verified in the browser afterwards.

**Correctness verification**, browser, decoder path vs. a provider forced onto the `<video>` path, comparing pixels
frame by frame (`verifyExactDecode`):

| Source | Timeline fps | Frames | Result |
|---|---|---|---|
| `counter30.mp4` (frame number encoded as blocks) | 30 / 24 / 25 / 60 | 180 / 144 / 150 / 360 | all bit-identical |
| `test-video.mp4` (24 fps, 720×1280) | 30 / 25 / 60 | 90 / 75 / 180 | all bit-identical |
| `test-video.mp4`, random order | 30 | 10 | all bit-identical |
| Benchmark 1080p (sequential, jumps, last 5 frames) | 30 | 98 | all bit-identical |
| 4K | 30 | 32 | all bit-identical |
| VP9 WebM | 30 | 90 | decoder used, all bit-identical |
| Rotation metadata (90°) | 30 | 60 | fell back to `<video>` ✓ |
| VP9 with alpha | 30 | 60 | fell back to `<video>` ✓ |

That is **1,329 frames, 0 differences**. In addition, the benchmark project's final renders hash identically to the
original pre-Phase-18 code (taken by stashing the changes), and every export passes the in-app validation.

**A real bug found by this verification, and fixed.** The project samples source frame n at (n + 0.5) / fps. A 24 fps
source on a 30 fps timeline puts every 5th sample **exactly on a source-frame boundary**. There the frame shown is
decided by sub-microsecond rounding:

- Chrome's `<video>` showed the earlier frame at 0.58333… s and the later one at 0.25 s. It rounds container timestamps
  to microseconds in two steps (measured with `requestVideoFrameCallback`), so its choice depends on the file.
- First attempt: a fixed "earlier frame on ties" rule matched 6 of 12 tie frames, then failed on the rest. Rejected.
- Fix: **`sourceTimeSec()`** samples at (n + 0.5 + 10⁻⁴) / fps, about 3 µs past the midpoint. That is far beyond any
  microsecond rounding and far inside the frame.
  - It is shared by the preview `<video>` path and both exact paths, so preview and export agree.
  - Rates without ties are unaffected (hashes unchanged).
  - For tie frames of rate-converted sources, output is now deterministic. Before, it depended on Chrome's rounding of
    each file.

Tests: `sequential-frame-cursor.test.ts` (7), with fake decoder streams. They cover exactly-once sequential decoding,
frame repetition when the output rate is above the source rate, restarts on backward and far-forward jumps, random vs
sequential agreement, the end of the stream, t before the first frame, and empty streams.

## 3. Optimization 2 — spatial effect kernels (bit-exact)

**Bottleneck** (baseline §2.5). The blur effect cost ≈ 20 ms of a 35 ms preview frame; glow and sharpen use the same
pass. `boxPass` walked one channel at a time through a per-line closure, and the vertical pass strode down columns.

**Change.** `src/lib/effects/process.ts` `boxPass`:

- All four channels advance in one walk.
- The vertical pass runs row by row, with one float64 accumulator per column.
- Every channel's running sum sees **exactly the same additions in the same order**, so the output is bit-identical.

**Verification:**

- `src/lib/perf/kernels.test.ts` keeps the old pass verbatim as a reference. It compares byte for byte over 6 shapes
  (including 1×1 and radius > size), 5 radii and both axes.
- The benchmark render hashes are unchanged.

**Result:** blur 24.2 → 6.3 ms, glow 30.2 → 7.5 ms, sharpen 9.0 → 3.4 ms. Full-resolution preview, interleaved A/B:
34.9–37.5 → 23.3 ms.

## 4. Optimization 3 — feathered masks: refine distances only inside the feather band (bit-exact)

**Bottleneck** (baseline §2.11, found by the cache probe). A cache miss on the PiP's feathered ellipse cost ≈ 75 ms.
Every frame of an animated feathered mask misses. In Node, the signed distance field took 45.6 ms, broken down as:

| Edge detection | Distance transform | Per-pixel sub-pixel refinement |
|---|---|---|
| 16.7 ms | 9.5 ms | **28.2 ms** |

**Change.** `src/lib/masks/raster.ts`:

- `signedDistanceField` takes an optional band, and `shapeCoverage` passes `profileSaturation(feather, expansion)`.
- A pixel whose coarse distance (center to nearest edge pixel, already computed by the distance transform), minus a
  3 px slack, is beyond the distance where `edgeProfile` saturates gets ±∞ instead of a refined distance.
- The refined distance is never below coarse − 2.45 px: the edge pieces examined lie in the 3×3 neighbourhood
  (≤ √2 px), each within ~1.03 px of its own pixel center. So those pixels' coverage is exactly 0 or 1 either way.
- `signedDistanceField` without a band, its exported contract, is unchanged.

**Verification:**

- A byte-exactness test over 34 random concave and star polygons plus a pixel-aligned rectangle:
  - feathers 0.4, 1, 3, 12.5 and 40;
  - expansions −15, −6, 0, 2.3 and 5;
  - compared against coverage computed from the exact, unbanded field: **identical**.
- All 56 mask tests pass, and the render hashes are unchanged.

**Result:** shapeCoverage 46.7 → 26.2 ms (Node); a browser frame with a mask miss 105.9 → 64.3 ms.

**Tried first, no gain:** removing a per-pixel side-table allocation in edge detection. V8 already eliminated it, so the
time was unchanged; reverted.

## 5. Optimization 4 — GPU-backed isolation surfaces (and a consistency fix)

**Bottleneck** (baseline §2.6 and §2.8). Every isolated layer and both sides of every transition were drawn on
`willReadFrequently` (CPU) canvases. Drawing a video frame into one costs 4.5 ms, against 1.0 ms on a GPU canvas. The
demo playback trace had `drawImage` at 31 % self time.

**Change.** `DrawOptions.getScratch(slot, readback)`:

- Surfaces nothing reads back go on GPU canvases. That covers alpha mattes, luma mattes (converted on their own
  surface), masks, transition sides without effects, and the transition mix.
- Layers with effects or a colour-decontaminated matte, which use `getImageData`, keep CPU surfaces.
- The renderers keep one canvas per (slot, readback) pair.
- `mixPixels` transitions read their sides back, which works on either kind of canvas.

**Pixels — measured, and why the change is correct.** Measured on the same code, with surfaces forced CPU vs GPU:

- **Transition frames:** differ by at most **1 level** per channel (PSNR 57–71 dB): last-bit rounding of the dissolve
  blend.
- **The demo's alpha-matted PiP:** differs by up to 81 levels **inside its opaque area**. Investigated: that is the
  video's downscale filter (720×1280 drawn at 296×432). Chrome's CPU and GPU canvases implement "high quality" smoothing
  differently. Unmatted video layers are drawn on the GPU main canvas, so compared with the same video drawn **without**
  a matte:
  - the **GPU** isolated layer is **identical** (max difference 0 over 102,906 values);
  - the old **CPU** path differed by up to 81 levels (PSNR 38 dB).

  So, before this change, adding a background-removal matte visibly changed the sharpness of the video under it. It no
  longer does.
- **Preview vs final** are still bit-identical on every checked frame.
- **New reference hashes:** benchmark frames 150 and 157 (transitions) changed; all other frames are unchanged.

**Result:**

- Benchmark transition frame: 35.1 → 24.4 ms.
- Demo matted-PiP frame, GPU-synced timing: 8.1 → 1.5 ms.
- Production demo playback main thread: 53 % → 8.5 % busy (8.35 → 0.7 ms per frame).
- Benchmark playback: 22.9 → 30.7 fps.

## 6. Optimization 5 — scrub seek coalescing

**Bottleneck** (baseline §2.4). While dragging, every new playhead position superseded the `<video>` seek still in
flight, so few seeks ever finished: 28 of 120 frames shown, lagging 12 frames.

**Change.** `MediaFrameProvider.peekFrame` (paused):

- A new target waits for the in-flight seek instead of cancelling it.
- `seeked` already notifies the preview, whose next render issues the newest target.
- A seek stuck longer than 1 s is superseded anyway.
- Playback is unchanged.

**Result:** 62–65 of 120 frames shown (was 28–29). Lag p50 3 frames (was 12–14), p95 5 (was 39–41). Settling after
release is 23 ms. The settled preview frames hash identically to the reference, so the final frame after a drag is
exact.

## 7. Tried, measured, and reverted

| Change | Hypothesis | Measured (interleaved A/B) | Decision |
|---|---|---|---|
| Composite only the isolated layer's paint region (sub-rect `drawImage` of the CPU scratch) | Less upload (microbenchmark: 0.45 vs 1.05 ms) | **23.3 → 37–38 ms (slower)** | Reverted. A sub-rect copy of a frequently-rewritten `willReadFrequently` canvas takes a slower path in Chrome; the microbenchmark didn't predict it. |
| Cache the mask coverage's ImageData | Skip a 330k-pixel loop per frame | No change | Reverted |
| Lookup table for byte → float, branch-only float → byte | Faster conversions | No change | Reverted |
| Inline the SDF's per-pixel side table | Fewer allocations | No change (V8 already eliminated them) | Reverted |

## 8. Considered, not done — with the measured reason

| Item | Reason |
|---|---|
| **Hardware encoding** | Already in place: WebCodecs `VideoEncoder` via Mediabunny, 1.3–1.6 ms per frame. Nothing to gain. |
| **Hardware decoding** | Done for export (§2). The preview uses `<video>`, which is already hardware-decoded. |
| **React re-render per frame** | 0.5–0.75 ms per frame in production. The 36 % seen earlier was development-build overhead. Not a bottleneck. |
| **Proxy media** | Import is under 30 ms. Playback now reaches the source's 30 fps on the busy benchmark project at full quality (60 fps at ½), and the remaining preview cost is compositing, not decoding. Not justified by the measurements. |
| **Preview / frame cache** | The exact-frame cursor is the sequential frame cache the export needed. A composited-frame cache would only help repeated scrubbing over the same frames, which wasn't measured as a bottleneck. |
| **Thumbnail caching** | The timeline has no thumbnails. |
| **Font caching** | Second `document.fonts.load` takes 0.05 ms, and `FinalRenderer` loads each face once. Already cached. |
| **Model caching** | Cache Storage (Phase 14), measured at 1 entry, 4.4 MB. Already cached. |
| **Text layout caching** | Warm resolve takes 0.01 ms, vs 1.03 ms cold. Already effective. |
| **Worker threads / parallel processing** | The remaining cost per final frame (≈ 25 ms) is the CPU effect kernels and their pixel conversions on the main thread. Moving them into a worker, or onto the GPU as WebGL kernels, is the next step. It's an architecture change, best scoped as its own phase. |
| **Random-jump seek latency** | 44–51 ms is the `<video>` element seeking to a keyframe and decoding (GOP 2 s). Making it faster would mean a decoded-frame cache or keyframe-dense proxies. Not done. |

## 9. Regression testing

| After | What was run |
|---|---|
| 1 (decoder) | Cursor tests. Browser pixel verification (1,329 frames). Render hashes vs the original code. Exports with in-app validation. Full suite. |
| 2 (blur) | Bit-exact kernel test. Effects, masks and composition suites. Render hashes. Full suite. |
| 3 (mask band) | Bit-exact coverage test. Mask suite. Render hashes. Full suite. |
| 4 (GPU surfaces) | Full suite. Same-code CPU/GPU pixel comparison. Comparison against unmatted rendering. Preview = final hashes. Export validation. |
| 5 (scrub) | Typecheck. Scrub benchmark ×2. Settled preview hashes vs reference. Full suite. |
| Mediabunny lazy import | Production bundle walk. Browser check: decoder used, frames identical, hashes unchanged. |
| Final tree | `vitest run`: **91 files, 1204 passed**, 34 skipped (browser-only evals). `tsc --noEmit`: 0 errors. `astro build`: ok. |

## 10. Files

**New:**

- `src/lib/composition/sequential-frame-cursor.ts` and `.test.ts`
- `src/lib/perf/`:
  - `bench-project.ts`, `stats.ts`, `perf-harness.ts` (browser)
  - `perf.test.ts`, `kernels.test.ts` (timings run with `PERF=1`)

**Changed:**

| File | Change |
|---|---|
| `composition/media-frame-provider.ts` | WebCodecs exact path, `sourceTimeSec`, seek coalescing |
| `composition/draw.ts`, `preview-renderer.ts`, `final-renderer.ts` | Readback-aware scratch surfaces |
| `effects/process.ts` | `boxPass` |
| `masks/raster.ts` | Banded SDF |
| `render/job.ts` | `stageMs`: per-stage export timing in `RenderOutcome` |
| `project/media-host.ts`, `CompositionPlaygroundPanel.tsx` | Pass the file blob to `addVideo` |
| `export/export.test.ts` | Mock gains `stageMs` |

**Data:** `.tmp-test-assets/phase18/`:

- benchmark and fallback media
- reference hashes
- the development playback trace
