# Release Test Matrix — Phase 21 (commit `6214b8f`)

**Status key:**
- ✅ **Verified:** run on this commit with the stated evidence.
- ◐ **Partial:** some of it verified, part failed or not covered.
- ❌ **Failed.**
- ○ **Not tested.**
- ⛔ **Blocked:** needs hardware, services, data or credentials not available here.

"Same code" means verified in an earlier phase on code that this commit did not change, and is labelled as such.

## 1. Automated checks

| Check | Command | Exit | Result | Status |
|---|---|---|---|---|
| Unit / integration (Node) | `npm test` | 0 | 1226 passed, 34 skipped (92 files) | ✅ |
| Type check | `npx tsc --noEmit -p .` | 0 | 0 errors | ✅ |
| Astro / template check | `npx astro check` | 0 | 0 errors / 0 warnings / 22 hints | ✅ |
| Production build | `npm run build` | 0 | Complete (large-chunk warning) | ✅ |
| Lint | — | — | No linter configured | ○ (B-08) |
| E2E suite | — | — | None exists; workflows run via the browser harness (§3) | ○ (B-08) |
| Render eval (ffmpeg) | `RENDER_EVAL_DIR=.tmp-test-assets/phase20/render npx vitest run src/lib/render/real-render.eval.test.ts` | 0 | 54/54 on 9 renders made by this commit | ✅ (not reproducible in a clean checkout: B-08) |
| Export eval (ffmpeg) | `EXPORT_EVAL_DIR=.tmp-test-assets/phase20/export npx vitest run src/lib/export/export-real.eval.test.ts` | 0 | 48 passed, 28 conditional skips | ✅ (same caveat) |
| AI voices eval | `npx vitest run src/lib/ai/real-voices.eval.test.ts` | 0 | 4/4 | ✅ (same caveat) |
| Clean install | `git clone` → `npm ci` → `npm test` → `npm run build` | 0 / 0 / 0 | 1120 passed, 11 skipped (eval suites skip: inputs git-ignored) | ◐ |
| Dependency audit | `npm audit` | 1 | 7 (3 high, 4 moderate), unreachable (K-11) | ◐ |
| Outdated | `npm outdated` | 1 | 12 behind; onnxruntime-web dev prerelease (K-07) | ◐ |

## 2. Features

| Area | Unit tests | Live / independent evidence on this commit | Status |
|---|---|---|---|
| Timeline / editing ops | ✅ | All workflows; undo after recovery | ✅ |
| Canvas / preview | ✅ | Preview = final 7/7 bit-identical; 30.8 fps playback | ✅ |
| Transform / crop | ✅ | Render eval transform / keyframe checks | ✅ |
| Text | ✅ | Render eval text checks; captions in exported frame | ✅ |
| Graphics / SVG | ✅ | P9; sanitizer tests | ✅ |
| Keyframes | ✅ | 960 keyframes (P9); eval | ✅ |
| Effects | ✅ (bit-exact kernels) | P3 / P9 export valid | ✅ (K-02 speed) |
| Transitions | ✅ | All 8 types (Phase 19, same composition code); Dissolve valid after RC2 | ✅ |
| Audio | ✅ | Sync check on every export; 30-min sync +0.00 ms (RC2) | ✅ (K-01) |
| Captions | ✅ | Whisper, SRT / VTT, burned in | ✅ (K-14) |
| Masks | ✅ | P9; eval mask checks | ✅ |
| Background removal — image | ✅ | P4; synthetic benchmark | ✅ (quality claims ⛔ §5) |
| Background removal — video | ✅ (unit) | **Held mattes: IoU 0.904 / 6 % pixels wrong on motion; 172 MB per 8 s** | ❌ (B-04, B-05) |
| Matte refinement in editor | — | "Clean edges" changes 14,749 px; no choke / feather / shift | ◐ (K-05) |
| AI features | ✅ | Cancel verified on this commit; run + apply in Phase 19 (same AI code) | ✅ |
| Rendering | ✅ | 54 ffmpeg checks | ✅ |
| Export | ✅ | 48 ffmpeg checks; P3 / P5 / P9 exports ffprobed | ✅ |
| Persistence | ✅ (41 project tests) | Reopen identical ×6 projects + missing-media project | ✅ |
| Crash recovery | ✅ | Simulated crash → identical | ✅ (real process kill: Phase 17, same code) |
| Performance | — | §9 of the audit | ✅ (K-02, K-03) |

## 3. Workflows (live)

| | Workflow | Run on this commit | Status |
|---|---|---|---|
| A | Import → edit → preview → export | P3 | ✅ |
| B | Multi-layer, text / graphics, animate → render | P9 | ✅ |
| C | Audio + captions → sync → export | P5 + exported-frame check | ✅ |
| D | Background removal → refine → composite → export | P4 + cancel / retry + refine toggle + held-vs-fresh measurement | ◐ (B-04, B-05, K-05) |
| E | Save → close → reopen → continue editing | P3, P4, P5, P9, P8, e2 | ✅ |
| F | Interrupt processing / export → recover | Bg-removal cancel; AI cancel; export cancel (eval); crash simulation | ✅ (simulated crash) |
| G | Missing media → relink | e2 project | ✅ |
| H | Resolutions / frame rates | Eval suites (9 renders, 19 exports) | ✅ |
| I | Transparent export | P9 WebM VP9 alpha; VP8 / VP9 alpha evals | ✅ (WebM only) |

## 4. Environments

| Environment | Status |
|---|---|
| Chrome 154, macOS 14+, Intel, 8 GB, dev server | ✅ |
| Chrome 154, production build via `node dist/server/entry.mjs` (Phase 20) | ◐ (editor loads, bg removal works single-threaded; B-01) |
| Production deployment behind a proxy with headers | ⛔ (no deployment config exists) |
| Firefox, Safari, Edge | ○ |
| Windows, Linux, Apple Silicon | ○ |
| Low-memory (≤ 4 GB) or mobile devices | ○ |

## 5. Background removal quality

| Test | Status |
|---|---|
| Synthetic image benchmark (25 cases, ground truth) | ✅ run. Weak: curly hair, transparent / semi-transparent, smoke, motion blur, complex background |
| Synthetic video benchmark (9 cases, 8 frames, per-frame matting) | ✅ run (doesn't exercise the editor's sampled path) |
| Editor video path (sampled + held) vs per-frame | ❌ IoU 0.904 between samples on motion |
| Real-footage ground-truth benchmark (hair, soft edges, halos, contamination) | ⛔ no licensed dataset in the repository |
| Comparative evaluation vs a reference tool / model | ⛔ not available |
| Human visual rating | ○ (review UI exists; no ratings recorded) |
| Long-video (≥ 5 min) stability | ○ (extrapolated failure, B-05) |
| GPU / CPU fallback | ✅ WASM (U²-Net pinned to WASM); single-threaded without isolation (10.8 s vs 3.2 s) |
| Cancellation and error recovery | ✅ |

## 6. Outstanding tests (must run before V1.0)

1. Video matte correctness on motion, after the B-04 fix: per-frame IoU ≥ 0.98 vs a per-frame reference on talking / walking / hand-motion clips.
2. Long-video background removal (10 min): memory, time, project size, after the B-05 fix.
3. A CI run on a clean checkout, including regenerated eval artifacts.
4. Production deployment with headers: workflows A–I re-run there.
5. Cross-browser / OS / device matrix (§4).
6. Real-footage matting benchmark + human rating.
7. A real renderer-process crash on the release commit.
8. A 60-minute export (memory scales with audio, K-03).
9. Accessibility review of the editor UI (not started).
10. Exporting a project whose **only** missing media is an image (the missing-audio case is verified; the image-only refusal message is untested).
