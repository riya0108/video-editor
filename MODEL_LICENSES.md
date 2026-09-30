# Model & Dependency License Audit

Scope: every model (existing or proposed) touched by the background-removal / matting system covered in `MATTE_IMPLEMENTATION_PLAN.md`. This is **not** a full-app license audit — `kokoro-js`/F5-TTS (voice cloning) and the Whisper models (captions/transcription) are out of scope here, though the same RMBG-1.4 finding below also affects this app's captions "occlude by person" feature, which is a separate consumer of the same model.

Verified 2026-09-26 by reading each project's own `LICENSE` file / Hugging Face model card via web search. **Re-verify at actual implementation time** — upstream licenses can and do change between minor versions (BRIA has shipped different license text across RMBG point releases).

## ⚠️ Pre-existing risk already in production (not introduced by this plan)

### briaai/RMBG-1.4 — **non-commercial only**

- **Used today** in: `src/lib/captions/person-cutout.ts` (`loadSegmenter`, exported as `PERSON_SEGMENTATION_MODEL`), consumed by:
  - `src/lib/media/bg-removal-image.ts` — Remove Background tool's "no green screen" mode for **still images**
  - `person-cutout.ts`'s `generateSubjectCutouts` — Remove Background tool's "no green screen" mode for **video**
  - `person-cutout.ts`'s other exports — Video Editor's captions "occlude by person" style
  - `src/lib/ffmpeg/passerby-track.ts` — passerby-removal auto-tracking
- **License**: BRIA's own "bria-rmbg-1.4" license — a Creative-Commons-style license restricted to **non-commercial use**. Commercial use requires a **paid** license agreement directly with BRIA ([bria.ai/bria-huggingface-model-license-agreement](https://bria.ai/bria-huggingface-model-license-agreement/)).
- **Risk**: if this product is (or becomes) a commercial/paid offering, every one of the four features above is currently running on a model whose license does not permit that use. This is already flagged in the codebase's own comments (`selfie-segmenter.ts` line 13-14) but nothing currently gates or warns about it at the product level.
- **Recommendation** (see plan, Phase 1): replace RMBG-1.4 with **U²-Net (Apache-2.0)** for the general/product "no green screen" case, which needs no licensing gate at all. Until that swap ships, treat every RMBG-1.4-backed feature as commercially unshippable without a BRIA license.

Source: [briaai/RMBG-1.4 discussion #4](https://huggingface.co/briaai/RMBG-1.4/discussions/4), [briaai/RMBG-1.4 model card](https://huggingface.co/briaai/RMBG-1.4).

## Models proposed for the new matting pipeline

| Model | Role in pipeline | Repo license | Weights license | Commercial use | Redistribution | Verdict |
|---|---|---|---|---|---|---|
| **MODNet** (ZHKKKe/MODNet) | Portrait matte | Apache-2.0 | Apache-2.0 (per repo LICENSE, covers code+released checkpoints) | ✅ Yes | ✅ Yes, with NOTICE/attribution | **Use** — self-host the checkpoint |
| **U²-Net** (xuebinqin/U-2-Net) | Coarse/general segmentation, product matte, RMBG-1.4 replacement | Apache-2.0 | Apache-2.0 | ✅ Yes | ✅ Yes, with NOTICE/attribution | **Bundled and live** — see the dedicated section below for provenance + a real WebGPU compatibility fix |
| **BackgroundMattingV2** (PeterL1n) | Known-background matte (only when a clean background plate is available) | MIT | MIT | ✅ Yes | ✅ Yes | **Use conditionally** — low priority, this app's upload flow rarely gives a background plate |
| **RobustVideoMatting (RVM)** (PeterL1n) | Temporal video matte (the diagram's "RVM / temporal" box) | **GPL-3.0** | GPL-3.0 | ⚠️ Copyleft | ⚠️ GPL-3.0 requires derivative works (including code statically/dynamically linked in the same product) to also be GPL-3.0 | **DO NOT INTEGRATE** into this proprietary codebase without a separate legal review and either (a) isolating it as a fully separate GPL-licensed microservice with no linking into this app, or (b) securing a different license from the authors. **Flagged per the master instructions' own explicit example.** |
| **MediaPipe Selfie Segmenter** (Google) | Person video matte — *already in production*, proposed as the license-safe stand-in for RVM's role | Apache-2.0 (framework + model) | Apache-2.0 | ✅ Yes | ✅ Yes | **Already in use, keep using** — see plan for how this fills RVM's slot without the GPL risk |

### Why MediaPipe Selfie Segmenter instead of RVM for video

The architecture diagram calls for a dedicated temporal video-matting network (RVM). RVM's GPL-3.0 license makes it unusable here. Rather than leave that box empty, the plan (Phase 2) proposes running the already-integrated, Apache-2.0 MediaPipe Selfie Segmenter **per-frame** (not sparse-sampled, as today) plus a classical (non-model, license-free) exponential-moving-average temporal smoothing pass on the alpha channel. This is a real quality downgrade versus a purpose-built temporal network — it will not match RVM's flicker suppression on fast motion — and that limitation is called out explicitly in the plan rather than glossed over.

## Already-integrated ML dependencies (informational, not re-audited in depth)

| Dependency | Used for | License | Note |
|---|---|---|---|
| `onnxruntime-web` (Microsoft) | ONNX inference runtime | MIT | No model-weight implications; pure runtime |
| `@mediapipe/tasks-vision` (Google) | MediaPipe runtime | Apache-2.0 | — |
| `@huggingface/transformers` (transformers.js) | Runs RMBG-1.4, Whisper, etc. | Apache-2.0 | The runtime is fine; it's the *weights it loads* (RMBG-1.4) that carry the restriction above |
| `realesr-general-x4v3.onnx` (xinntao/Real-ESRGAN, modified) | Upscale tool's super-resolution model | BSD-3-Clause | Already self-hosted in `public/models/`; unrelated to matting but confirms the project's existing "self-host small, permissively-licensed weights" convention this plan follows |

## Redistribution requirements this plan must satisfy

Apache-2.0 (MODNet, U²-Net, MediaPipe) and MIT (BackgroundMattingV2, onnxruntime-web) both permit redistributing the model weights inside this proprietary app, provided the license text and a NOTICE of any modifications travel with the redistributed files. Action: add `public/models/LICENSES/` containing each redistributed model's license text, and note in this file which checkpoint file corresponds to which license (done above). No weights are being modified/fine-tuned in Phase 1, so no additional NOTICE-of-changes obligation arises yet — if a checkpoint is later fine-tuned or pruned, that must be logged here.

## U²-Net (u2netp) — bundled 2026-09-26

Downloaded, unmodified, from **https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx** — the exact ONNX export the popular `danielgatis/rembg` tool (MIT-licensed code; re-exports the official U²-Net checkpoints, doesn't relicense them) itself downloads at runtime. The model weights remain covered by U²-Net's own Apache-2.0 license, not rembg's MIT license on its own code.

- File: `public/models/u2netp.onnx`, 4,574,861 bytes, SHA-256 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
- License text + provenance NOTICE: `public/models/LICENSES/U2NET_LICENSE.txt`, `U2NET_NOTICE.txt`.
- **Verified functional** end to end (real ONNX Runtime session load + inference against a real photo, both via a Node/`onnxruntime-node` smoke test and live in-browser through the actual tool UI) — see `MATTE_IMPLEMENTATION_PLAN.md`'s phase reports for details.
- **Real, confirmed platform limitation, not a licensing issue**: this graph's MaxPool layers use `ceil_mode=1` (a genuine U²-Net architectural detail), which onnxruntime-web's **WebGPU** backend rejects ("using ceil() in shape computation is not yet supported for MaxPool" — a known upstream limitation, [microsoft/onnxruntime#20938](https://github.com/microsoft/onnxruntime/issues/20938)). Confirmed live in this browser. Fixed by pinning `src/lib/matting/models/u2net.ts` to the WASM execution provider (same category of fix `src/lib/upscale/real-esrgan.ts` already applies for a different WebGPU incompatibility) — WASM has no such restriction and was confirmed working.
- **Real, confirmed quality limitation (not a bug), on a high-contrast chroma-style backdrop**: on a real test photo with a saturated green background, U²-Net's raw output assigns low-but-nonzero confidence to a band of pixels that are, in reality, 100% background — confirmed by direct inspection of the model's own raw output tensor, not assumed. `pipeline/decontaminate.ts` now detects and suppresses this (its own foreground-color unmixing proves there's no real foreground signal there) and `pipeline/remove-background.ts`'s guided-filter radius for segmentation-class models was reduced from 7 to 2 after confirming empirically that a smaller radius roughly halves the residual fringe (21,984 → 12,672 affected pixels on the test image). Some residual fringe remains at fine, high-curvature geometry (finger edges) even after both fixes — a genuine gap between a general segmentation model and a purpose-built matting network, exactly the caveat this document and `MATTE_IMPLEMENTATION_PLAN.md` already state.

## Outstanding verification

1. Confirm the exact MODNet checkpoint file this plan intends to redistribute is the one covered by the repo's Apache-2.0 LICENSE file (not a third-party re-upload with unclear provenance — several exist on Hugging Face, e.g. mirrors under different accounts). Not yet bundled.
2. Re-fetch and re-read RMBG-1.4's live license page at implementation time — BRIA has revised license terms across versions before. The U²-Net swap above has now shipped for the image "no green screen" path, so this is lower-urgency than when originally written, but still applies to RMBG-1.4's remaining callers (video AI mode, captions "occlude by person", passerby-track — see Phase 4 in the plan).
3. If any commercial deal with BRIA is ever pursued instead of finishing the U²-Net migration for the remaining callers, this document must be updated to reflect that RMBG-1.4 has moved from "non-commercial" to "commercially licensed" status for this specific product.
