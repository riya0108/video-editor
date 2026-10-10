# Release Blockers — Phase 19

> **Superseded by FINAL_KNOWN_ISSUES.md / PRODUCTION_READINESS_REPORT.md (Phase 20, RC2).** Since this was written, P1-1 (Dissolve false-fail) and P1-2 (long-export memory) have been **fixed and verified**.

**Status: NOT READY TO RELEASE — 2 open blockers.**

A blocker is any P0, plus any P1 that makes a common workflow fail or report failure with no acceptable workaround.

## Open

| ID | Blocker | Why it blocks | Smallest fix |
|---|---|---|---|
| **P1-1** | Exports that use the built-in **Dissolve** transition are reported as **FAILED**: the job fails and the file is named `-FAILED-VALIDATION`, although the video is correct | A built-in, default feature makes every export of the project "fail". Users will distrust every export, or think the app is broken. | Make the fidelity check tolerant of codec loss on high-detail content. Options are in KNOWN_ISSUES.md P1-1. It's a validator change, not a feature, but it sets how strict validation is, so it needs a product decision. |
| **P1-2** | Exports are buffered entirely in memory (≈ 3.8× the file size at peak). A 10-min 1080p export peaked at 2.3 GB; ~30 min would likely crash the tab | Long-form export (podcasts, tutorials, the "long videos" use case) can lose the whole render near the end. Not reproduced at 30 min; extrapolated from the measured 10-min run. | Stream the output to a file (Mediabunny `StreamTarget` → save-picker writable). Alternatively, cap export length with a clear message until streaming lands. |

## Resolved in this phase

| ID | Issue | Fix | Verified |
|---|---|---|---|
| P0-1 | WebM videos imported as audio-only, or rejected (screen recordings, the app's own WebM / alpha exports) | `refineImportKind`: probe ambiguous containers for a video track | 5 unit tests; live import of alpha WebM (video) and Opus WebM (audio); transparent export of the result |
| P2-3 | Phase 18 regression: exporting past the end of a truncated video was ~15× slow | Decoder cursor holds the last frame at end of stream | Unit test; live 150 s+ → 9.3 s, export valid |

## Not blocking (tracked in KNOWN_ISSUES.md)

- **P1-3:** 30-minute audio limit. It's clearly communicated and has a workaround, but it is a significant limitation for podcasts.
- **P2-1:** slow exports with full-frame CPU effects.
- **P2-2:** truncated videos import without a warning.
- **P3-1 … P3-8.**

## What passed

All 10 real-world projects import, edit, preview, save, close, reopen identically (document and bit-identical frames) and render. 9 of 10 export and validate; the 10th is P1-1.

Also passing:
- corrupted / missing / relinked media;
- a 10-minute 1080p export;
- a 601-clip, 3,000-keyframe project;
- 11 export formats, codecs, sizes and framings;
- export cancellation.

No crash or uncaught error came from the app (FULL_QA_REPORT.md).
