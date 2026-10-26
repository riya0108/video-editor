# Release Readiness Audit — Phase 21

| | |
|---|---|
| Date | 2026-10-10 |
| Commit audited | `6214b8f` on `master`. Working tree clean; **1 commit ahead of `origin/main` (not pushed)** |
| Auditor's environment | macOS, 8-core Intel, 8 GB; Chrome 154 (automation profile); Node 26.5.0; npm 11.17.0; Astro 7.3.8 |

**Scope:** an audit only. No source file was changed, and no file was deleted. The only writes were these five documents and test artifacts under the git-ignored `.tmp-test-assets/` and the browser's private storage.

Companion documents: RELEASE_TEST_MATRIX.md (every check with evidence), RELEASE_BLOCKERS.md (ranked blockers), KNOWN_ISSUES.md (all findings, P0–P3), V1_RELEASE_CHECKLIST.md (release criteria).

**Supersession:** these replace the Phase 19 `RELEASE_BLOCKERS.md` / `KNOWN_ISSUES.md`, whose previous content stays in git history. The Phase 20 documents (PRODUCTION_READINESS_REPORT.md, FINAL_KNOWN_ISSUES.md) are superseded where they disagree.

**Correction to Phase 20:** RC2 stated that "all engineering gates pass". This audit found **two engineering defects that block release**, both in video background removal: B-04 and B-05.

---

## 1. Executive summary

**The application is NOT ready for V1.0.** The core editor is unusually well verified:
- preview and final render are bit-identical;
- exports pass an independent ffmpeg check;
- save → close → reopen and crash recovery are lossless;
- long exports are bounded in memory.

But **8 confirmed P1 findings** block a public / commercial V1.0. There are **no P0s**.

| | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| Confirmed findings | 0 | 8 | 12 | 13 |

The P1 blockers fall into four groups:

- **Engineering (2):** video background removal is wrong on moving subjects (held mattes, measured IoU 0.904) and cannot scale to long clips (172 MB of bitmaps for 8 s).
- **Deployment (1):** the production Node server sends no cross-origin isolation or security headers.
- **Legal / rights (4):**
  - a GPL wasm is distributed without a license text or source offer;
  - a non-commercial model is used by other site tools;
  - demo media of an identifiable person has no recorded provenance;
  - fonts and two models ship without their license texts.
- **Verification (1):** there is no CI. The render / export / voice evaluation suites can't be reproduced from the repository, because their inputs are git-ignored. Cross-browser behaviour is untested.

**Single highest-priority next action:** rework video background removal so mattes are correct on every frame and stored with bounded memory (B-04 + B-05). It's the only *output-correctness* blocker, in a headline feature. Push and tag the current commit first (a 1-minute checkpoint, §2), and start the ops/legal items in parallel; they need owners, not code.

---

## 2. Repository and architecture findings

### Baseline

| Item | Value |
|---|---|
| Branch / status | `master`, clean, ahead of `origin/main` by 1 (`6214b8f`) |
| History | 25 commits; phases 4–20 in the last 9 |
| Runtime | Node ≥ 22.12 (`engines`); run on 26.5.0. Browser: Chromium with WebCodecs, OffscreenCanvas and OPFS (Chrome 154 only tested) |
| Framework | Astro 7.3.8 (static output plus 1 on-demand route through `@astrojs/node` standalone); React 19.2 islands; Tailwind 4 |
| Key media dependencies | mediabunny 1.61.3 (mux/demux, WebCodecs); `@ffmpeg/ffmpeg` 0.12.15 + `@ffmpeg/core-mt` 0.12.10 (other tools); onnxruntime-web **1.26.0-dev.20260416** (a prerelease); @huggingface/transformers 4.2 (Whisper); @mediapipe/tasks-vision 1.0.1; kokoro-js 1.2.1 |
| Source size | ≈ 70k lines in `src/` (excluding tests); 92 test files |
| Scripts | `dev`, `build`, `preview` (`scripts/preview-server.mjs`), `test` (`vitest run`), `postinstall` (copies the ffmpeg core, builds drawtext fonts) |
| Not present | **No CI** (no `.github/`), **no lint config / linter**, no E2E framework (Playwright / Cypress), no Dockerfile or deploy manifest for the Node server (`vercel.json` and `public/_headers` exist but don't apply to it) |
| Documentation | 60+ phase documents (architecture, test reports and changelogs per engine), README, MODEL_LICENSES.md, MEDIA_SECURITY.md |

**Checkpoint recommendation:** the tree is clean and committed, but `6214b8f` exists only on this machine. Before any further modification:
- `git push origin master:<release-branch>`;
- tag it, e.g. `v1.0.0-rc2`.

### Architecture

The editor lives at `/tools/video/composition-preview` and runs fully in the browser:
- **Timeline engine:** immutable model, history and operations (`src/lib/timeline`).
- **Composition:** resolve → draw, shared by `PreviewRenderer` and `FinalRenderer` (`src/lib/composition`). The shared code is why preview equals final.
- **Feature engines:** animation, effects, transitions, masks, audio, captions, AI (`src/lib/*`).
- **Render / export:** the render job, validation, presets and queue (`src/lib/render`, `src/lib/export`); WebCodecs via Mediabunny; output streamed to OPFS.
- **Persistence:** `.clipbench` bundle, IndexedDB versions, autosave, crash recovery (`src/lib/project`).

The **only server code** is `src/pages/api/transcribe-source.ts`, which runs yt-dlp for link transcription. It is used by the Video Transcript tool, not the editor.

**Finding:** the architecture is coherent and the renderer is single-sourced. The weak point is the asset layer for *generated* media: background-removal mattes are held as full-resolution `ImageBitmap`s in the frame provider and embedded as PNGs in the project (B-05).

---

## 3. Verification commands and actual results

Logs: `.tmp-test-assets/phase21-logs` (scratch). All runs are on `6214b8f`.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm test` | 0 | 92 files; **1226 passed, 34 skipped** (16 s) |
| 2 | `npx tsc --noEmit -p .` | 0 | 0 errors |
| 3 | `npx astro check` | 0 | 0 errors, 0 warnings, 22 hints |
| 4 | `npm run build` | 0 | Complete; Vite large-chunk warning (kokoro 2.1 MB, transformers, ONNX wasm — all lazy) |
| 5 | `npm audit` | **1** | 7 vulnerabilities (3 high, 4 moderate). All in Node-only optional deps of `kokoro-js` → `transformers@3` (§10) |
| 6 | `npm outdated` | 1 | 12 packages behind; **onnxruntime-web is a dev prerelease** |
| 7 | `RENDER_EVAL_DIR=.tmp-test-assets/phase20/render npx vitest run src/lib/render/real-render.eval.test.ts` | 0 | **54/54** ffmpeg checks on 9 renders made by this commit (1080p 24/25/30/50/60; 1080×1080; 1080×1920; 4K 30/60) |
| 8 | `EXPORT_EVAL_DIR=.tmp-test-assets/phase20/export npx vitest run src/lib/export/export-real.eval.test.ts` | 0 | **48 passed**, 28 conditional skips; 19 export cases made by this commit |
| 9 | `npx vitest run src/lib/ai/real-voices.eval.test.ts` | 0 | 4/4 |
| 10 | Lint | n/a | **No linter configured**; `npx --no-install eslint` is not installed (exit 1) |
| 11 | E2E | n/a | No E2E framework. Workflows were run live through the browser harness (`src/lib/qa`) via chrome-devtools (§5) |
| 12 | Clean install: `git clone` → `npm ci` → `npm test` → `npm run build` | 0 / 0 / 0 | `npm ci` 16 s (npm 11 skipped install scripts of `sharp`, `onnxruntime-node`, `protobufjs`, `fsevents`, which aren't needed in the browser); **only 1120 tests run, 11 skipped**: the 3 eval files skip because their inputs live in the git-ignored `.tmp-test-assets/` |
| 13 | Matting quality benchmark (`runQualityBenchmark`, browser) | — | 25 image + 9 video synthetic cases, all succeeded (34 s); §6 |
| 14 | Performance harness (`src/lib/perf`, browser) | — | §9 |
| 15 | Preview vs final hashes (benchmark project, 7 frames) | — | **7/7 bit-identical**, matching the RC2 reference hashes |

**Blocked or not run:**
- browsers other than Chrome; other OSes and devices;
- a real renderer-process crash on this commit (the simulated crash passed; the process kill passed in Phase 17);
- a real-footage matting benchmark (no licensed ground-truth dataset);
- a production deployment behind a proxy.

---

## 4. Feature-by-feature status

| Area | Status | Evidence (this audit unless stated) |
|---|---|---|
| Timeline | ✅ | Unit suites; 601-clip / 3,000-keyframe project (Phase 19 on the same timeline code); every workflow below |
| Canvas / preview | ✅ | Preview = final bit-identical; playback at 30.8 fps on the benchmark |
| Transform / crop | ✅ | Keyframed transforms in P3, P8, P9; render eval checks positions per frame |
| Text / typography | ✅ | Titles, labels, captions; burned-in captions seen in an exported frame |
| Shapes / graphics / SVG | ✅ | P9 (20 shapes, 17 blend modes); hostile-SVG test (Phase 20) |
| Keyframes | ✅ | 960 keyframes (P9); render eval keyframe checks |
| Effects | ✅ (P2: speed) | P3/P7/P9; bit-exact kernel tests |
| Transitions | ✅ | All 8 types; Dissolve export validates (RC2) |
| Audio | ✅ (P2: 30-min file limit) | 7-track mix; A/V sync checked on every export; 30-min export sync +0.00 ms (RC2) |
| Captions | ✅ (P3: overlap, K-14) | Whisper (8 accurate captions); SRT/VTT; burned-in frame verified |
| Masks / compositing | ✅ | All 4 mask types; render eval mask checks |
| Background removal — image | ✅ (quality caveats §6) | P4 photo; synthetic benchmark |
| **Background removal — video** | ❌ **P1** | Held mattes wrong on motion (B-04); memory does not scale (B-05) |
| AI features | ✅ | Shot / face / reframe / filler / silence / highlight / speaker run and applied (Phase 19 P6/P10); AI job cancel verified |
| Rendering | ✅ | 54/54 ffmpeg checks |
| Export | ✅ | 48/48 ffmpeg checks; 30-min export valid; streamed to disk |
| Persistence | ✅ | Every reopen identical (document and frames) |
| Recovery | ✅ (simulated) | Crash simulation → recovered identical → editing continues |
| Performance | ✅ (P2: CPU effects) | §9 |
| Startup / packaging | ⚠️ | Clean install works. No deploy config for the Node server (B-01); no CI (B-08) |

---

## 5. End-to-end workflow results (live, on `6214b8f`)

| Workflow | Status | Evidence |
|---|---|---|
| **A** Import → edit → preview → export | **Verified** | P3 product ad: 4 files imported; keyframes, effects, push transition; 6/6 preview frames, none skipped; export valid (ffprobe: 1080×1080, 180 frames, H.264 + AAC, 6.0 s) |
| **B** Multi-layer + text / graphics + animate → render | **Verified** | P9: 32 layers, 17 blend modes, 960 keyframes, 4 mask types, 6-effect stack; reopen identical; render valid |
| **C** Audio + captions → sync → export | **Verified** | P5: Whisper 8 captions ("You won't believe, but…"), 149-cue SRT, messy SRT, VTT; 4 min 30 s export valid incl. A/V-sync check; exported frame at 1.2 s shows the matching caption |
| **D** Remove image/video background → refine → composite → export | **Partially verified** | Works end to end on a photo and an 8 s clip (export valid). "Clean edges" refinement measurably changes 14,749 edge pixels. **But** video mattes are wrong between samples on motion (B-04); there is no matte-specific choke / feather / edge shift in the editor (K-05); long clips untested and projected to fail (B-05) |
| **E** Save complex project → close → reopen → continue | **Verified** | Every project reopened with a field-identical document and bit-identical frames; editing and undo after reopen / recovery verified |
| **F** Interrupt processing / export → recover | **Verified** (crash simulated) | Background-removal Cancel button → settled in 252 ms, no partial matte, retry OK. AI job cancelled at 5.7 %, no partial result. Export cancel eval (cancelled, no file). Crash simulation → banner after 16.5 s → Recover → identical |
| **G** Missing media → relink | **Verified** | 2 files deleted → "2 media item(s) unavailable"; export refused with reason; relink both (exact) → frames identical → export valid |
| **H** Different resolutions / frame rates | **Verified** | Render eval: 24/25/30/50/60 fps, 1080p / square / vertical / 4K at 30 and 60 (54 ffmpeg checks). Export eval: 25/48/60 fps, 4K, 720p, letterbox / crop (48 checks). 10- and 30-min exports (RC2, same code) |
| **I** Transparent export | **Verified for WebM** | P9 VP9 + alpha: `alpha_mode=1`, 54.6 % transparent at frame 75, 180/180 frames decode; VP8 / VP9 alpha eval cases pass. MOV / MP4 alpha (ProRes 4444 / HEVC-alpha) is not offered (by design) |

---

## 6. Background-removal audit and benchmark gaps

### Models

| Model | Used by | File / source | Version / provenance | License |
|---|---|---|---|---|
| **U²-Net — u2netp** (small variant) | Editor image + video background removal; Remove Background tool | `public/models/u2netp.onnx`, 4.4 MB, from `danielgatis/rembg` release v0.0.0 (unmodified official checkpoint) | NOTICE in `public/models/LICENSES/` | Apache-2.0 ✅ |
| MediaPipe Selfie Segmenter | Other tools (person cutout) | `public/models/selfie_segmenter.tflite` | — | Apache-2.0. **License text not shipped** (B-07) |
| BRIA RMBG-1.4 | Other tools (caption "occlude by person", passerby). **Never selected in the editor**: router license filter; `allowNonCommercial` is set nowhere | Downloaded from Hugging Face at runtime | — | **Non-commercial** (B-03) |
| MODNet, BackgroundMattingV2 | Adapters registered; weights not bundled | — | — | Apache / MIT |

### Pipeline (editor)

- **Image:** U²-Net → refinement / decontamination (`src/lib/matting/pipeline`).
- **Video:** `generateClipMatte` mattes **6 samples per second** (every 5th frame at 30 fps). Each matte is held until the next sample. Mattes are stored as full-resolution `ImageBitmap`s and embedded in the project as PNGs.
- U²-Net runs on **WASM** by design, after a WebGPU incompatibility (Phase 14).

### Measured

**Synthetic benchmark** (repo dataset; metrics relative to synthetic ground truth only):

| Category | Mean SAD | Mean MAD |
|---|---|---|
| Easy | 341 | 0.0015 |
| Medium | 1,186 | 0.0051 |
| Hard | 7,225 | 0.0314 |

Weak cases:

| Case | SAD | Connectivity error |
|---|---|---|
| Curly hair | 17,515 | 0.154 |
| Semi-transparent fabric | 23,232 | — |
| Transparent objects | 17,327 | — |
| Smoke | 20,247 | 0.642 |
| Motion blur | 12,980 | — |
| Complex background | 13,037 | — |

Video synthetic cases (8 frames each, matted per frame): temporal error 0.0002–0.0200 (worst: fast movement).

**Editor video path (real 720×1280 talking-head clip):** the held matte vs a fresh per-frame matte between samples.

| Situation | IoU | Pixels wrong |
|---|---|---|
| Moving hands | **0.904** | **6.0 %** |
| Calmer frames | 0.967–0.995 | — |

**Memory:** 49 mattes × 720×1280×4 = **172 MB per 8 s**. A 10-min clip extrapolates to ≈ 12.6 GB and ≈ 40 min of processing (not reproduced).

**Without cross-origin isolation (production):** photo removal took 10.8 s vs 3.2 s (single-threaded WASM), with no failure.

**Cancellation and recovery:** verified (§5 F).

### Gaps — what must exist before any quality claim

The Photoshop-level quality claim is **not supported**; there's no comparative evidence.

1. **A real-footage ground-truth benchmark.** At least 100 images and 20 clips under a license that permits evaluation, e.g. P3M-10k / AIM-500 / PPM-100 for portraits and hair, Distinctions-646 for fine structure, VideoMatte240K / VideoMatting108 for video. Report SAD / MSE / gradient / connectivity and temporal metrics against ground-truth alpha, per category.
2. **The editor's actual video path** (sampled + held), measured against per-frame ground truth. The synthetic benchmark mattes every frame, so it can't see B-04.
3. **A comparative evaluation:** the same inputs through a reference tool or model (e.g. a commercial remover, or `u2net` full / MODNet / RVM-class for reference only), with a blind human rating panel. The "Human visual evaluation" section of the report is empty.
4. **Long-video stability:** a 5–10 min clip: memory, time, project size.
5. **Halo, contamination and transparency measurements** on real composites: edge colour error vs a clean plate.

---

## 7. Rendering and export findings

- **Preview vs final:** single code path; 7/7 frames bit-identical on this commit.
- **Correctness:** resolution, frame rate, duration, frame count, A/V sync, text / graphics, transforms / keyframes, effects / transitions, masks / alpha, codec / container and transparency are all checked by an **independent decoder (ffmpeg)** in the eval suites on files made by this commit (54 + 48 checks), and by the in-app validation report on every export.
- **Long exports:** streamed to OPFS. MP4/MOV keep fast start (`moov` before `mdat`, verified). 10 min: 555 MB peak; 30 min (1.71 GB): valid, 907 MB peak (RC2, same code).
- **Codecs:** H.264 / HEVC / AV1 / VP9 in MP4; H.264 / HEVC in MOV; VP9 / AV1 / VP8 in WebM; AAC / Opus. Invalid combinations are refused; the AAC 384 kbit/s encoder failure is preflighted.
- **Findings:**
  - export memory still grows with audio length (K-03);
  - full-frame CPU effects are slow, 0.2–0.6× realtime (K-02);
  - VP8 + alpha is slow (K-15).

---

## 8. Persistence and recovery findings

- `.clipbench` = checksummed bundle (document plus generated-media PNGs). The user's own media is referenced by name and fingerprint, not embedded.
- IndexedDB versions; autosave 2 s after an edit; crash detection by session heartbeat (15 s staleness).
- **Verified on this commit:**
  - every reopen field-identical with bit-identical frames;
  - missing media detected and relinked (exact);
  - simulated crash recovered identically, with editing continuing afterwards.
- Phase 17 (same persistence code; unchanged since `71e539a` apart from `media-host.ts` passing the file blob) verified:
  - corrupt / truncated / random project files refused;
  - damaged embedded matte healed;
  - interrupted save leaves the file intact;
  - real renderer-process kill recovered.
- **Findings:**
  - Projects with video background removal grow by ≈ 115 KB per matted sample: an 8 s clip makes a 5.5 MB project; a 10 min clip would be ≈ 410 MB (B-05).
  - SVG markup loaded from a project isn't re-sanitized; it's contained because SVGs only render as `<img>` (K-21).

---

## 9. Performance findings (measured on this commit, Chrome 154 / Intel Mac)

| Metric | Value |
|---|---|
| Preview composite, 1080p full / ½ (benchmark project) | p50 30.6 ms / 10.6 ms |
| Playback (benchmark, auto quality) | 30.8 fps (source rate), 1 long task in 5 s |
| Scrub: random jump to exact frame | p50 46 ms, p95 71 ms |
| Scrub: drag | 63 of 120 frames shown, p50 lag 3 frames |
| Final render throughput | 30.2 fps |
| Export, 10 s 1080p benchmark | 11.5 s (27.7 render fps), heap +3 MB |
| Export, 10 / 30 min 1080p | 93.5 s / 280 s; peak heap 555 / 907 MB (RC2, same code) |
| Startup JS (editor) | 674 KB (215 KB gzip) |
| Video background removal | ≈ 4 s of processing per second of video; 172 MB per 8 s (B-05) |

Development build; the production build was measured in Phase 18 / 20. Not tested: low-end devices, Apple Silicon, Windows / Linux, other browsers.

---

## 10. Security and licensing findings

**Confirmed fixed earlier and re-checked:**
- Astro RCE (7.3.8 installed);
- SSRF guard (unit tests pass);
- SVG sanitizer;
- no DOM-injection sinks;
- no committed secrets;
- `execFile` without a shell (URL last, temp dir removed in `finally`);
- preview-server path traversal → 404.

| ID | Finding | Type |
|---|---|---|
| B-01 | Production Node server sends **no COOP/COEP, CSP, nosniff or Referrer-Policy** | Confirmed |
| K-06 | `/api/transcribe-source`: no auth or rate limit; redirect / DNS-rebinding SSRF can't be blocked in-app | Potential, needs deployment egress rules |
| K-11 | 7 npm advisories (`sharp@0.34.5` libvips/libheif, `onnxruntime-node`, `adm-zip`, `global-agent`, `roarr`, `sprintf-js`, `boolean` deprecated). Not reachable: Node-only optional deps of `kokoro-js` → `transformers@3`; not in the browser bundle or the server bundle | Confirmed present, assessed not exploitable |
| K-07 | onnxruntime-web pinned to a **dev prerelease** | Supply-chain / stability risk |
| B-02 | `@ffmpeg/core-mt` (**GPL-2.0-or-later**, libx264 build) is served to every browser from `public/ffmpeg/` with **no license text and no source offer**. Not used by the editor | Confirmed compliance gap |
| B-03 | **RMBG-1.4 non-commercial** model used by other site tools | Confirmed (MODEL_LICENSES.md) |
| B-06 | **Demo media provenance unknown:** `public/videos/hero-phone-demo.mp4` (identifiable person, burned-in social captions) and `public/images/bg-removal-person.webp` / `bg-removal-office.webp`; no credits or licenses in the repository | Potential rights violation, needs investigation |
| B-07 | Fonts (OFL-1.1, `public/fonts/*.ttf` + fontsource) and the models `selfie_segmenter.tflite` (Apache-2.0) and `realesr-general-x4v3.onnx` (BSD-3) ship **without license texts** | Confirmed compliance gap |
| K-08 | Whisper / Kokoro / translation / RMBG weights download at runtime from Hugging Face. Third-party availability; offline use only after caching | Risk |

**Packaging:**
- A clean install works.
- npm 11 doesn't run install scripts of `sharp`, `onnxruntime-node`, `protobufjs`; none are needed by the browser app.
- The server needs `yt-dlp` and `ffmpeg` on PATH, which is documented only in astro.config / the README requirements.

---

## 11. Blockers ranked by severity

See RELEASE_BLOCKERS.md. Summary:

| Rank | ID | Sev | Blocker |
|---|---|---|---|
| 1 | B-04 | P1 | Video background removal: held mattes wrong on moving subjects (6 % of pixels, IoU 0.904) |
| 2 | B-05 | P1 | Video background removal memory / project size don't scale (172 MB per 8 s → ~12.6 GB per 10 min) |
| 3 | B-01 | P1 | Production server sends no isolation / security headers |
| 4 | B-02 | P1 | GPL ffmpeg wasm distributed without license / source offer |
| 5 | B-06 | P1 | Demo media of an identifiable person, provenance unknown |
| 6 | B-03 | P1 | RMBG-1.4 non-commercial in site tools |
| 7 | B-07 | P1 | Fonts / models shipped without license texts |
| 8 | B-08 | P1 | No CI; eval suites not reproducible from the repository; no cross-browser verification |

## 12. Recommended fix order

| # | Action | Owner |
|---|---|---|
| 0 | **Checkpoint:** push `6214b8f` and tag `v1.0.0-rc2` | — |
| 1 | **B-04 + B-05 together** (one redesign of video matte storage): matte every frame, or a temporally propagated / motion-compensated matte, stored as compact alpha (single-channel, possibly lower resolution with guided upsampling), streamed or paged rather than all-in-memory, encoded efficiently in the project | Engineering |
| 2 | **B-08:** CI running `npm test`, `tsc`, `astro check`, build, plus regeneration of the eval artifacts in a headless Chrome step; add a linter | Engineering |
| 3 | **B-01 + K-06:** deployment manifest or proxy config with COOP/COEP/CORP, CSP, nosniff, Referrer-Policy; egress firewall and rate limit for `transcribe-source` | Ops |
| 4 | **B-02, B-03, B-06, B-07** | Legal / product (engineering ships notices and replaces assets) |
| 5 | Cross-browser and device pass (Firefox, Safari, Edge; Windows, Linux, Apple Silicon; 8 GB and lower-RAM machines) | QA |
| 6 | Real-footage matting benchmark (§6 gaps) before any quality marketing | ML / QA |
| 7 | P2s, highest user impact first: K-01 (30-min audio), K-02 (CPU effects), K-04 (truncated video), K-05 (matte refinement controls) | Engineering |

## 13. Explicit release criteria

V1_RELEASE_CHECKLIST.md lists every gate with its verification.

**V1.0 may be declared only when:**
- all P0 and P1 findings are closed and re-verified;
- CI is green on a clean checkout, including the eval suites;
- all workflows A–I are re-verified on the release commit, **including in the production deployment**;
- the cross-browser matrix passes on the supported browsers;
- legal sign-off covers every distributed component and asset.
