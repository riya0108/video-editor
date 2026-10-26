# Known Issues — Phase 21 audit (commit `6214b8f`)

> Replaces the Phase 19 version of this file (in git history). The release blockers (B-01 … B-08, P1) are detailed in RELEASE_BLOCKERS.md; everything else is here.

**Severity:**
- **P0** — critical: data loss, a security issue, or a fundamental failure.
- **P1** — major: core workflows fail, or output is materially incorrect.
- **P2** — moderate: significant defect with a workaround.
- **P3** — minor.

**Counts:** P0 = 0 · P1 = 8 (B-01 … B-08) · P2 = 12 · P3 = 13.

## P1 — see RELEASE_BLOCKERS.md

| ID | Issue |
|---|---|
| B-04 | Video background removal wrong on motion (IoU 0.904) |
| B-05 | Video matte memory / project size don't scale |
| B-01 | No isolation / security headers in production |
| B-02 | GPL ffmpeg wasm without license / source offer |
| B-06 | Demo media provenance |
| B-03 | RMBG-1.4 non-commercial in site tools |
| B-07 | Missing license texts |
| B-08 | Verification not reproducible / no CI / single browser |

## P2 — moderate

| ID | Issue | Evidence | Affected | Repro | User impact | Corrective action | Verify after fix |
|---|---|---|---|---|---|---|---|
| K-01 | Audio files > 30 min refused | 31-min WAV → "longer than the 30-minute limit…" (Phase 19; code unchanged) | `src/lib/audio/safety.ts`, `source-store.ts` (full-file decode to Float32) | Import a 31-min WAV | Full podcast episodes must be split | Streamed / windowed decode and peaks | Import 2 h audio; memory bounded; export valid |
| K-02 | Full-frame CPU effects make exports slower than realtime | 6 s square ad 30.7 s; 84 s podcast 139 s (Phase 19; same effect code) | `src/lib/effects/process.ts`, `composition/draw.ts` | Blur / exposure on a full-frame still → export | Long waits | GPU (WebGL) or worker effects; cache effect output for static layers | ≥ 1× realtime on the same projects |
| K-03 | Export memory grows with audio length (full stereo mix built before encoding) | 30-min export peak 907 MB (RC2); ≈ 23 MB/min transient | `src/lib/render/audio.ts`, `job.ts` | 60-min export | Very long exports may exhaust memory | Chunked mix + encode | 2 h export, peak < 1 GB |
| K-04 | Truncated / damaged video imports silently; picture freezes past the data; soundtrack reported "no audio" | Phase 19 (12 MB cut of a 58 MB MP4) | `media-frame-provider.ts`, `audio/source-store.ts` | Import a truncated MP4 | Silent loss of picture / audio | Detect duration-vs-data mismatch; warn like truncated WAV; keep the intact audio | Warning shown; intact audio plays |
| K-05 | Matte refinement in the editor is limited (invert, channel, "Clean edges" only) | Masks panel source; toggle test: 14,749 px changed | `MasksPanel.tsx` | Try to choke or feather a matte | Can't fix halos / chokes without masks | Expose the pipeline's refinement (choke, feather, edge shift) on mattes | UI test + render eval |
| K-06 | `/api/transcribe-source`: no auth or rate limit; redirect / DNS-rebinding SSRF can't be blocked in-app | Route source; guard tests | `src/pages/api/transcribe-source.ts`, `lib/net/public-url.ts` | — | Server abuse / internal probing | Rate limit, auth or captcha; egress firewall to private ranges | Load test; egress test |
| K-07 | onnxruntime-web pinned to a **dev prerelease** (`1.26.0-dev.20260416`) | `npm outdated` | `package.json` | — | Unstable runtime in production | Move to a stable release (1.30.0) and re-run the matting benchmarks | Benchmark + workflow D unchanged or better |
| K-08 | Whisper / translation / TTS / RMBG weights download from Hugging Face at runtime | Source (`auto-caption.ts`, `model-cache.ts`) | Captions, AI fillers | Offline first use | Features fail offline or if Hugging Face is unavailable | Self-host weights or document; offline-ready messaging | Offline test |
| K-09 | Production `crossOriginIsolated=false` makes AI 3.4× slower even after B-01 if a host omits headers | Phase 20 measurement | Matting, ONNX | — | Slow | Runtime warning when not isolated | — |
| K-10 | No "New project" command | UI | `ProjectFileBar.tsx` | Fresh page opens the demo | Clutter | Add New project | UI test |
| K-11 | 7 npm advisories (3 high) in Node-only optional deps of `kokoro-js` → `transformers@3`; deprecated `boolean@3.2.0` | `npm audit` | `package-lock.json` | — | Not reachable today | Track upstream; consider replacing `kokoro-js` or overriding transformers | Audit clean |
| K-12 | Quality claims unsupported: no real-footage benchmark; synthetic hard cases weak (curly hair SAD 17,515; smoke 20,247; transparent 17,327) | Benchmark run (§6 of the audit) | Matting | — | Over-promising | Build the benchmark (audit §6) | Report with per-category metrics |

## P3 — minor

| ID | Issue | Evidence / affected | Corrective action |
|---|---|---|---|
| K-13 | Multi-file drop stacks the last file frontmost | Phase 19 P3 | Respect drop order, or add images below video |
| K-14 | Multiple caption tracks default to the same position and overlap | Phase 19 P5; visible in this audit's exported frame | Offset new caption tracks |
| K-15 | VP8 + alpha export slow (23 s vs ~2 s for VP9 alpha) | Export eval timing | Prefer VP9; warn |
| K-16 | Corrupt-video error message blames a codec and shows Chrome internals | Phase 19 | Separate "damaged file" from "unsupported codec" |
| K-17 | Dropping `.srt` / `.vtt` on the editor isn't routed to caption import | Phase 19 | Route by extension |
| K-18 | Project frame rate fixed at 30 fps | `CompositionPlaygroundPanel` `FPS = 30` | Per-project frame rate |
| K-19 | Engine API edges not reachable from the UI (partial text style un-normalized; `trimClip` end before start clamps to 1 frame) | QA harness | Normalize in `insertClip`; refuse invalid trims |
| K-20 | Large projects (600 clips): playback 49 fps with long tasks (development build) | Phase 19 | Profile in production |
| K-21 | SVG markup from project files isn't re-sanitized (contained by `<img>`) | Phase 20 | Sanitize on load |
| K-22 | Large client chunks (kokoro 2.1 MB etc.) warn at build | Build log | Already lazy; split further |
| K-23 | `master` ahead of `origin/main` by 1 (no remote checkpoint of RC2) | `git status -sb` | Push + tag |
| K-24 | Export-while-missing refusal names only audio; the image-only case is untested | Phase 19 / 21 | Test; list all missing media |
| K-25 | Video background removal is slow (≈ 4 s of processing per 1 s of video) | P4 build log | Covered by the B-05 redesign |

## Verified non-issues (don't re-report)

- Clipping warnings on loud mixes are correct.
- The "Shorts ≤ 3 min" warning is correct.
- The beforeunload prompt is correct.
- P3 frame-0 "sharpness" and P9 "vanishing video" were investigated and are correct behaviour.
- The P3 document diff is a QA-harness artifact (K-19).
