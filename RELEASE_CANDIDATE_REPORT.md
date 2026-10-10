# Release Candidate Report — RC2

Date: 2026-10-10. This is the Phase 20 production audit of the editor (`/tools/video/composition-preview`) and the deployable it ships in. It was run on the code at `71e539a` plus the uncommitted Phases 18–20.

No features were added. Code changed only to fix defects found by the audit (§5).

**Verdict:** this build is **Release Candidate 2, not V1.0.**
- RC1 → RC2 fixed the two blocking editor bugs, P1-1 and P1-2 (§2b).
- Two gates remain, both deployment / legal (PRODUCTION_READINESS_REPORT.md).

## 1. What was run

| Suite | How | Result |
|---|---|---|
| **Full automated suite** | `vitest run` (92 files) | **1226 passed** (RC2), 0 failed. 34 skipped, all conditional: per-variant eval checks that don't apply to a given file, plus `PERF=1` timing benches |
| **Type and template checks** | `tsc --noEmit`; `astro check` | 0 errors; 0 errors / 0 warnings |
| **Production build** | `astro build` (Astro 7.3.8) | Complete. Editor startup JS 674 KB (215 KB gzip), unchanged from Phase 18 |
| **Rendering tests** | All 9 Phase 15 render cases **re-rendered with the current code** (`src/lib/qa/rc-regen.ts`), then decoded independently by ffmpeg (`RENDER_EVAL_DIR=.tmp-test-assets/phase20/render vitest run real-render.eval`) | 9/9 in-app reports OK. **54/54 ffmpeg checks pass**: per-frame source identity, cut and dissolve, alpha, effects, masks, keyframes, text, captions, audio sync. Covers 1080p at 24/25/30/50/60 fps and 4K at 30/60 fps |
| **Export tests** | All 19 Phase 16 export cases re-run with the current code, then ffmpeg-checked (`EXPORT_EVAL_DIR=… vitest run export-real.eval`) | 16 produced files, all with valid reports; cancel → cancelled, no file; both refusals refused with the right reason; the AAC 384k preflight failed as designed. **48/48 ffmpeg checks pass** (28 conditional skips) |
| **Export variants** (Phase 19, current export code) | 11 formats, codecs, sizes, rates and framings, plus cancel | 11/11 valid; cancel clean |
| **Integration (real-world projects)** | The 10 Phase 19 projects, each imported, edited, previewed, saved, closed, reopened, rendered and exported; Projects 7 and 9 re-run on the final code | 10/10 reopen identical (document and bit-identical frames). **10/10 export valid**. Project 7 validates since the RC2 fidelity fix |
| **Persistence tests** | Unit: `project.test.ts` (41) + suite. Live: 10 project round trips; missing media → relink → bit-identical; 601-clip project | Pass |
| **Crash / recovery** | Live: the app's `pagehide`/`unload` handlers suppressed before load (the page then never marks itself cleanly closed, exactly what a crash leaves behind) → unsaved edits → autosave → page torn down → fresh load | Recovery banner after 16 s: "p2 wasn't closed properly… (version 2) can be recovered" → **Recover** → document identical, 3/3 frames bit-identical. The renderer-kill variant passed in Phase 17 |
| **Security checks** | Dependency audit; review of DOM sinks, secrets, the server route and SVG import; live SSRF probing; hostile-SVG execution test; production response headers | 1 critical + 1 high **fixed**; 1 P1 deployment issue open; details in §4 |
| **Dependency audit** | `npm audit` before/after | 18 → 7 advisories (critical 1 → 0, high 13 → 3). The remaining 7 are unreachable in production (§4.1) |
| **License audit** | Every production package's declared license (246 packages, by install path) + the ML model register | Editor clean. Two items need legal sign-off before a commercial release (§4.3) |
| **Performance** | Phase 18 harness, same benchmark project | No regression (§3, area 20) |

## 2. Fixes made during the audit

| Sev | Defect | Fix | Verified |
|---|---|---|---|
| **P0 (security)** | Astro 7.2.3: remote code execution through AVIF image optimization (GHSA-26w7-cxv4-gfx2) plus a base-path authorization bypass (GHSA-376h-93r7-7g6f). The deployed Node server **does** expose the `/_image` endpoint | `astro` → ^7.2.10 (resolves 7.3.8), then `npm audit fix` (semver-compatible only, never `--force`) | Audit: 0 critical; full suite, `astro check`, build and live editor re-verified on 7.3.8 |
| **P1 (security)** | SSRF guard of `/api/transcribe-source` (a URL fetched server-side by yt-dlp) compared hostname *text*. These passed: `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]` (cloud metadata), `[::]`, `0.x.x.x`, `100.64/10`, `metadata.google.internal`, and public names resolving to loopback (`localtest.me`) | `src/lib/net/public-url.ts`: parses every address form (IPv4-mapped/compatible, NAT64), blocks every non-global range, refuses internal-only names and credentials in URLs, and **resolves the name and checks every address** | 5 unit tests (all bypasses + regressions + public links); live: 7 bypass URLs → HTTP 400 |
| P2 | `npm run preview` (documented "preview your build") returned **500** for every page: it served `dist/` while the Node-adapter build is `dist/client/` | `scripts/preview-server.mjs` serves `dist/client` when present | Pages 200 with COOP/COEP; path traversal → 404 |
| P3 (security) | SVG import sanitizer stripped only *quoted* `href`s; an unquoted `href=javascript:…` survived | Sanitizer handles unquoted values | 2 unit tests (incl. idempotence); hostile-SVG live test |

Earlier phases' fixes (Phase 19 WebM import P0, Phase 18 cursor regression) were re-verified by the suite and the re-renders.

## 2b. RC2 — the two blocking editor bugs, fixed

| ID | Fix | Verified |
|---|---|---|
| **P1-1** Dissolve export reported FAILED | `validate.ts` fidelity is **relative**. A checkpoint under 30 dB passes only if it is ≥ 20 dB, matches its own render at least as well as the renders of frames k±1 (captured during render, 480 px), and at least half of the checkpoints are still ≥ 30 dB. | Measured on the real Project 7 frames: correct dissolve frames are 22–23 dB and best-matching; shifted frames match a neighbour better (17.8 vs 22.2 dB). 6 unit tests: codec-limited passes; shifted, black and global problems fail; edge cases. Live: **Project 7 validates** (2 frames reported as codec-limited); 19 export eval cases + 9 renders re-checked by ffmpeg (48 + 54 pass) |
| **P1-2** long exports buffered in memory | (1) `render/output-file.ts`: the muxer streams into an **Origin Private File System** file (no prompt); the result is a disk-backed Blob; MP4/MOV keep **Fast Start** (`fastStart: 'reserve'` with exact/bounded packet counts); in-memory fallback without OPFS. <br>(2) **Audio encoded before video:** interleaving otherwise held every encoded video packet until the end (heap grew ≈ 34 KB/frame = the average packet). <br>(3) Validation keeps only channel 0 of the mix and decodes only the 1 s window the sync check reads (`lagSlice`, proven identical to the full-length measurement). <br>(4) A file is deleted when its job is removed from the list (`release()`); a page's leftovers are swept at the next export. Progress bar reordered (audio, then video). | 10-min 1080p: peak heap **2,339 → 555 MB**, flat during video. **30-min 1080p (54,000 frames, 1.71 GB): valid, sync +0.00 ms, peak 907 MB**, 280 s. MP4/MOV start with `moov` (fast start kept). Download path: blob URL serves the disk file byte-identically. Cancelled exports leave no file; sweep 15 → 0 verified. 4 unit tests |

## 3. Audit by area

| # | Area | Evidence (this audit + earlier phases on the current code) | Status |
|---|---|---|---|
| 1 | Core editor stability | ≈ 40 live sessions across Phases 19–20: no crash, freeze or uncaught error caused by the app; console clean | ✅ |
| 2 | Background removal | P4 (photo U²-Net 3.2 s; per-frame video matte 28 s; 19–28 % transparency verified); P9. Production build without cross-origin isolation: works, 10.8 s (single-threaded, see P1-4). Router excludes non-commercial models | ✅ (perf caveat P1-4) |
| 3 | Media engine | Import (images, video, audio, SVG, alpha WebM, Opus WebM, 158 MB 10-min video); WebCodecs exact-frame decode bit-identical to `<video>` on 1,329 frames (Phase 18); fallbacks (rotation, alpha); truncated file | ✅ (P2-2) |
| 4 | Timeline | Splits, moves, trims, multi-track, 601 clips / 61 tracks, 40 undo/redo in 1 ms; 1217 unit tests incl. the timeline suites | ✅ |
| 5 | Canvas | Preview = final bit-identical on checked frames; GPU isolation surfaces (Phase 18) verified against unmatted rendering | ✅ |
| 6 | Transform | Keyframed scale, rotation, position, anchor in P1–P3, P8–P10; reframe | ✅ |
| 7 | Text | Titles with stroke, shadow, emoji; labels; captions via the text engine | ✅ |
| 8 | Graphics | Shapes (rect, ellipse, polygon), shadows, SVG import; hostile SVGs contained | ✅ |
| 9 | Keyframes | 960 (P9) and 3,000 (large project) keyframes; render eval: box x keys verified per frame by ffmpeg | ✅ |
| 10 | Effects | Every effect type used across P3, P7, P9; bit-exact kernel tests | ✅ (speed P2-1) |
| 11 | Transitions | All 8 types (P7); cross-dissolve verified by ffmpeg; Dissolve exports validate (RC2) | ✅ |
| 12 | Audio | 7-track mix, gain, fades, mute; AAC/Opus; A/V sync checked by ffmpeg on every export eval | ✅ (P1-3: 30-min file limit) |
| 13 | Captions | Whisper (8 accurate captions, 2.8 s), SRT/VTT import with repair, presets, 4 tracks; render eval checks captions | ✅ (P3-3) |
| 14 | Masks | All 4 types, feather, add/subtract; bit-exact banded SDF | ✅ |
| 15 | AI features | Shot, face, reframe, filler, silence, highlight, speaker — run and applied (P6, P10) | ✅ |
| 16 | Rendering | 9 re-renders, 54 ffmpeg checks | ✅ |
| 17 | Export | 16 + 11 valid exports, cancel, refusals, preflight; 10-min and **30-min** 1080p exports valid, streamed to disk, 907 MB peak (RC2) | ✅ (P2-5: audio-proportional memory) |
| 18 | Persistence | 10 + 2 projects bit-identical after reopen; missing media and relink | ✅ |
| 19 | Recovery | Simulated crash → recovered, identical (§1) | ✅ |
| 20 | Performance | Now vs Phase 18: export 10.3 s vs 11.7 s; final render 37.9 vs 38.4 fps; playback 38.7 fps, 0 long tasks; scrub 63/120 frames shown, lag 3; startup 674 KB | ✅ |

## 4. Security, dependency and license details

### 4.1 Dependency audit

| | Before | After |
|---|---|---|
| Total | 18 | 7 |
| Critical | 1 | 0 |
| High | 13 | 3 |
| Moderate | 4 | 4 |

The 7 remaining advisories all sit in **Node-only optional dependencies of `kokoro-js` → `@huggingface/transformers@3`**: `onnxruntime-node`, `sharp@0.34.5` (libvips/libheif CVEs), `adm-zip`, `global-agent` → `roarr` → `sprintf-js`. No upstream fix exists.

They aren't reachable in production:
- These libraries run in the **browser**, where they use `onnxruntime-web` and canvas.
- The production server bundle imports none of these packages; their names only appear as client asset paths in the manifest.
- Astro's own image service uses the patched `sharp@0.35.5`.

Status: accepted risk, recorded as P3-9.

### 4.2 Security review

**Fixed:**
- **Astro RCE** (§2).
- **SSRF** (§2).
- **SVG unquoted href** (§2).

**Hostile-SVG test (live):** `<script>`, `onload`, `javascript:`, `foreignObject` + `onerror`, external `href`, CSS `url()` and `<set>`, through both the import path and an unsanitized project-file path.
- Nothing executed (`window.__pwned` = 0) and nothing was fetched (0 external requests).
- SVGs only ever render as `<img>` from a Blob, which runs no scripts and loads nothing external.

**No dangerous DOM sinks:** no `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML`, `eval` or `new Function` in `src/`. No secrets are committed.

**Project files:** validated and checksummed on open (Phase 17: corrupt, truncated and random files are refused).

**Server route `/api/transcribe-source`:**
- `execFile` without a shell; a fixed argument list with the URL last, so no option injection.
- Size, duration and time limits.
- **Open:**
  - No authentication or rate limit (P2-4).
  - yt-dlp follows redirects and resolves DNS itself, so a redirect or DNS rebinding to an internal address can't be blocked in-app. The deployment must deny the server egress to private ranges (P2-4).

**Production headers — P1-4, open:** `node dist/server/entry.mjs` sends **no COOP/COEP and no security headers** (no CSP, `X-Content-Type-Options` or `Referrer-Policy`).
- `public/_headers` (Netlify/Cloudflare) and `vercel.json` don't apply to the Node server.
- The Node adapter serves static files without running middleware.
- Measured effect on the editor:
  - `crossOriginIsolated` is false and `SharedArrayBuffer` is undefined.
  - Background removal still works, but single-threaded (10.8 s vs 3.2 s).
  - WebCodecs export is unaffected.
- The site's other tools that use multithreaded ffmpeg.wasm (`@ffmpeg/core-mt`) need cross-origin isolation.

### 4.3 License audit

- **Production npm packages (246):**

  | License | Packages |
  |---|---|
  | MIT | 133 |
  | Apache-2.0 | 16 |
  | OFL-1.1 (fonts; embedding allowed) | 16 |
  | ISC | 14 |
  | BSD-3 | 8 |
  | BlueOak | 4 |
  | MPL-2.0 (`mediabunny`, `lightningcss`) | 3 |
  | LGPL-3.0 (`@img/sharp-libvips`) | 2 |
  | CC0/MIT | 2 |
  | Python-2.0 | 1 |
  | CC-BY-4.0 (`caniuse-lite`) | 1 |
  | GPL-2.0+ (`@ffmpeg/core-mt`) | 1 |
  | Optional platform binaries, not installed | 45 |

- **MPL-2.0** (`mediabunny`, shipped to the browser): file-level copyleft. Compliant while unmodified; ship a notice and a source link.
- **LGPL-3.0** (`sharp-libvips`): server-side only and dynamically linked. OK.
- **GPL-2.0-or-later — `@ffmpeg/core-mt`:** **distributed to every browser** (`public/ffmpeg/ffmpeg-core.wasm`, a libx264 build). The editor doesn't load it; other tools do. Distributing it means providing corresponding source and offering GPL terms for it. **Needs legal review** (P1-5).
- **ML models:**
  - The editor uses U²-Net (Apache-2.0), MediaPipe (Apache-2.0), Whisper (MIT) and Real-ESRGAN (BSD-3); license texts are in `public/models/LICENSES/`.
  - **`briaai/RMBG-1.4` is non-commercial only** and is still used by non-editor tools (caption "occlude by person", passerby tracking). It is excluded from the editor by the router's license filter.
  - It **blocks a commercial release of the site** until it is replaced or licensed (P1-5; MODEL_LICENSES.md).

## 5. Files changed in Phase 20

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | astro ^7.2.10 (7.3.8) and `npm audit fix` |
| `src/lib/net/public-url.ts` + test (new); `src/pages/api/transcribe-source.ts` | SSRF fix |
| `src/lib/graphics/svg.ts` + test | Unquoted href |
| `scripts/preview-server.mjs` | Serve `dist/client` |
| `src/lib/render/real-render.eval.test.ts`, `src/lib/export/export-real.eval.test.ts` | Optional `RENDER_EVAL_DIR` / `EXPORT_EVAL_DIR` |
| `src/lib/qa/rc-regen.ts` (new) | Re-renders the eval cases |

Artifacts are in `.tmp-test-assets/phase20/`.
