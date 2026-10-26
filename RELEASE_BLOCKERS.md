# Release Blockers — Phase 21 audit (commit `6214b8f`)

> Replaces the Phase 19 version of this file, which is in git history. **8 confirmed P1 blockers; 0 P0.** V1.0 is blocked until all are closed and re-verified.

Each entry lists: Evidence · Affected · Repro · User impact · Corrective action · Verification after fixing.

---

## B-04 · P1 · Video background removal is wrong on moving subjects

**Evidence:**
- `generateClipMatte` mattes 6 samples per second (`samplesPerSecond ?? 6`; every 5th frame at 30 fps) and holds each matte until the next sample (`frame-sequence.ts` sample-and-hold).
- On the real 720×1280 talking-head clip (P4), the held matte vs a fresh per-frame U²-Net matte:

  | Frames | IoU | Pixels wrong (\|Δα\| > 0.5) |
  |---|---|---|
  | 32–34 (hands moving) | **0.904** | **6.0 %** |
  | 184 | 0.967 | 2.2 % |
  | Calm frames | ≥ 0.984 | — |

**Affected:** `src/lib/composition/matte-generation.ts` (`sampleFrames`), `src/lib/composition/frame-sequence.ts`, `CompositionPlaygroundPanel.removeBackground`.

**Repro:** import a video with motion → Remove background → step through frames between samples (e.g. 32–34): the cut-out lags the moving hands (background shows through, or parts of the subject are clipped).

**User impact:** visible edge errors on 4 of every 5 frames whenever the subject moves. That's the core of a "remove background from video" feature.

**Corrective action:**
- Matte every output frame, or propagate / interpolate temporally (optical-flow warp of the last matte, or a temporal model with a compatible license).
- Keep the 6 fps sampling only as an explicit "draft" option.

**Verification after fixing:** per-frame IoU ≥ 0.98 and ≤ 1 % of pixels wrong vs a per-frame reference on 3 motion clips (talking, walking, fast hands); temporal consistency metric added for the editor path; export of P4 re-verified.

## B-05 · P1 · Video background removal memory and project size don't scale

**Evidence:**
- Mattes are held as full-resolution RGBA `ImageBitmap`s: 49 × 720×1280×4 = **172 MB for an 8 s clip**.
- They're embedded as PNGs: the P4 project is 5.5 MB.
- Processing took 32.4 s for 8 s of video.
- Extrapolated to 10 min at 6 fps: ≈ 12.6 GB of bitmaps, ≈ 410 MB of project, ≈ 40 min of processing. **Not reproduced.**
- Fixing B-04 by matting every frame multiplies all of this by 5.

**Affected:** `matte-generation.ts`, `media-frame-provider.ts` (`addFrameSequence`), `project/asset-registry.ts` (generated PNGs), `project/bundle.ts`.

**Repro:** Remove background on a long clip (≥ 2 min). Expected: memory grows with every sample, and the tab eventually crashes.

**User impact:** removing the background from anything longer than a short clip can crash the tab and lose the work; huge project files.

**Corrective action:**
- Store mattes as single-channel alpha (8-bit, optionally reduced resolution with guided upsampling at draw time).
- Encode them as a compressed alpha video or tiled chunks, not PNG per frame.
- Load on demand with an LRU cache, not all-resident.
- Show progress with time and size estimates and allow cancel (cancel already works).
- Set a documented length limit until this lands.

**Verification after fixing:** 10-min clip matted with peak heap and GPU memory bounded (e.g. < 1 GB), project growth measured, export valid, reopen identical.

## B-01 · P1 · Production server sends no isolation or security headers

**Evidence:** `node dist/server/entry.mjs` returns no `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, CSP, `X-Content-Type-Options` or `Referrer-Policy` (curl, Phase 20; unchanged since). In the browser: `crossOriginIsolated=false`, no `SharedArrayBuffer`. Background removal is 3.4× slower (10.8 s vs 3.2 s); multithreaded ffmpeg.wasm tools need isolation. `public/_headers` / `vercel.json` don't apply to the Node adapter, which serves static files without middleware.

**Affected:** deployment (no manifest in the repository), `astro.config.mjs` (Node standalone adapter).

**Repro:** `npm run build && node dist/server/entry.mjs`, then `curl -I /tools/video/composition-preview/`.

**User impact:** slower AI features; other tools break; no defense-in-depth headers.

**Corrective action:** ship a deployment config (reverse proxy or custom Node entry wrapping the adapter's handler) that sets COOP / COEP / CORP and a CSP compatible with WASM and workers (`'wasm-unsafe-eval'`), `nosniff` and `Referrer-Policy` on every response.

**Verification after fixing:** headers present on HTML, JS and WASM responses; `crossOriginIsolated=true`; workflows A–I pass in that deployment.

## B-02 · P1 · GPL ffmpeg wasm distributed without license or source offer

**Evidence:** `public/ffmpeg/ffmpeg-core.wasm` (31 MB, `@ffmpeg/core-mt` 0.12.10, **GPL-2.0-or-later**, libx264 build) is served to every browser. There's no LICENSE / COPYING beside it and no written source offer. The editor doesn't load it; other tools do.

**Affected:** `public/ffmpeg/`, `scripts/copy-ffmpeg-core.mjs`, tools using `@ffmpeg/ffmpeg`.

**User impact / risk:** a license violation on distribution; legal exposure.

**Corrective action:** legal review, then either (a) comply (ship the license text and the corresponding source or a written offer, and assess GPL implications for the combined app), or (b) replace with an LGPL build without x264/GPL components, or with WebCodecs.

**Verification after fixing:** a legal sign-off record; the license / source offer reachable from the deployed site.

## B-06 · P1 · Demo media of an identifiable person with unknown provenance

**Evidence:**
- `public/videos/hero-phone-demo.mp4`: an identifiable person with burned-in social-media captions; added in commit `611d952` / `820347f` with no credit.
- `public/images/bg-removal-person.webp` and `bg-removal-office.webp`: same situation.
- No credits, license or model release anywhere in the repository.

**Affected:** the demo project (`CompositionPlaygroundPanel` `DEMO_VIDEO_URL`), Remove Background tool demo, homepage.

**User impact / risk:** copyright and likeness-rights exposure on public release.

**Corrective action:** obtain and record rights (license + model release), or replace with owned / CC0 media; add a CREDITS file.

**Verification after fixing:** a credits file listing every bundled media asset with its license.

## B-03 · P1 · Non-commercial model (RMBG-1.4) used by site tools

**Evidence:** `src/lib/matting/models/rmbg-adapter.ts` and `src/lib/captions/person-cutout.ts` callers (`VideoEditorTool`, `CaptionsPreview`, `passerby-track`, `useBgRemoval*`). MODEL_LICENSES.md: BRIA RMBG-1.4 is non-commercial. **The editor is not affected:** the router excludes it, and `allowNonCommercial` is set nowhere.

**User impact / risk:** commercial use of the site violates the model license.

**Corrective action:** migrate the remaining callers to U²-Net / MediaPipe (both already integrated), or buy a BRIA license and record it.

**Verification after fixing:** a grep showing no runtime path to RMBG without a recorded license; affected tools re-tested.

## B-07 · P1 · Bundled fonts and models shipped without their license texts

**Evidence:** `public/fonts/*.ttf` (OFL-1.1, generated from fontsource), `public/models/selfie_segmenter.tflite` (Apache-2.0) and `public/models/realesr-general-x4v3.onnx` (BSD-3): `public/models/LICENSES/` covers only U²-Net and the MediaPipe detectors.

**Corrective action:** add OFL texts for each font family, Apache-2.0 / NOTICE for the selfie segmenter, BSD-3 for Real-ESRGAN, and an in-app or site "Open-source licenses" page.

**Verification after fixing:** every file under `public/models` and `public/fonts` maps to a shipped license text.

## B-08 · P1 · Release verification is not reproducible

**Evidence:**
- There's no CI and no linter.
- The ffmpeg-based render / export / voice eval suites read git-ignored `.tmp-test-assets/`. In a clean clone they are skipped: 1120 tests run instead of 1226.
- The workflow verification depends on a local browser harness run by hand.
- Only Chrome 154 on one macOS machine has been tested.

**Corrective action:**
- CI (`npm ci`, `npm test`, `tsc`, `astro check`, build).
- A headless-Chrome job that regenerates the eval artifacts (`src/lib/qa/rc-regen.ts`, probe harnesses) and runs the eval suites.
- Promote the QA harness workflows (A–I) to automated E2E tests.
- Add a linter.
- Define and run the supported-browser matrix.

**Verification after fixing:** CI green on a clean checkout with 0 eval suites skipped; matrix results recorded.

---

## Not blocking V1.0, but must be decided

- **K-01:** 30-min limit per audio file. Reclassified P2: clear message and a workaround.
- **K-02:** CPU effects 0.2–0.6× realtime.
- **K-06:** `transcribe-source` auth / rate limit / egress.
- **K-07:** onnxruntime-web dev prerelease.

See KNOWN_ISSUES.md.
