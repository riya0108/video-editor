# Clipbench Video Editor — Release Candidate 2 (RC2)

**Status: Release Candidate, not V1.0.** The editor's engineering gates all pass. Two gates are open: the production server's headers, and a licensing review. See PRODUCTION_READINESS_REPORT.md.

## What's in the editor

| Area | Features |
|---|---|
| Timeline | Multi-track video, overlay, image, text, graphic, caption and audio tracks; split, trim, move, duplicate, multi-select; snapping; undo/redo |
| Canvas and transform | Exact preview that matches the export pixel for pixel; position, scale, rotation, anchor, flip, crop, fit modes, 17 blend modes, opacity; guides and safe zones |
| Text and graphics | Styled text (stroke, shadow, background, spacing, alignment); shapes; sanitized SVG import |
| Keyframes | Every visual property, effect parameters and audio levels; easing |
| Effects | Color, exposure, temperature, tint, blur, sharpen, glow, vignette, grain |
| Transitions | Cut, fade, dissolve, cross-dissolve, slide, push, wipe, zoom |
| Masks and mattes | Rectangle, ellipse, polygon and freeform masks with feather, expansion and modes; alpha and luma mattes |
| Background removal | One-click AI cutouts of photos and videos (U²-Net), with edge refinement |
| Audio | Multi-track mix, volume, gain, fades, mute/solo, waveforms; sample-accurate sync in exports |
| Captions | Whisper auto-captions, SRT/VTT import with repair, styles, speakers, word timing |
| AI | Shot, scene, face, object, speaker, silence, filler-word and highlight detection; auto-reframe; B-roll suggestions — all applied to the timeline in one step |
| Export | MP4/MOV/WebM; H.264, HEVC, AV1, VP9, VP8; AAC/Opus; up to 4K and 60 fps; transparent WebM; letterbox and crop framing; presets for Reels, Shorts, YouTube and square; hardware encoding; each file is read back and validated before it's reported done |
| Projects | `.clipbench` files, autosave, version history, crash recovery, missing-media detection with relink |

## New since the last commit (Phases 18–20)

**Performance:**
- Exports are about **3.7× faster**: hardware-decoded exact frames.
- Previews with masks, mattes and transitions are much lighter on the CPU (GPU compositing).
- Blur, glow, sharpen and feathered masks are faster, with identical output.
- Smoother scrubbing: about twice as many frames shown while dragging.

**Fixes:**
- **Long exports no longer run out of memory.** Exports stream to disk as they render: a 30-minute 1080p export now peaks under 1 GB, where it would previously have crashed the tab. MP4/MOV files keep fast start.
- **Exports using the Dissolve transition are no longer reported as failed.** The quality check now tells fine-grained detail that compression smooths away apart from a wrong frame.
- WebM videos (screen recordings, transparent exports) import as video again.
- Truncated videos no longer make exports slow.
- `npm run preview` works.

**Security:**
- Patched a critical Astro vulnerability (remote code execution via image optimization).
- Hardened the link-download endpoint against server-side request forgery.
- Tightened SVG sanitizing.
- 10 further dependency advisories resolved.

## Known issues in RC2

- Audio files longer than 30 minutes must be split.
- Exports with effects on full-frame layers render slower than realtime.
- The production server must add cross-origin isolation headers; without them, background removal and AI features run single-threaded.
- Licensing review is pending for components used by other tools on the site.

Full list: FINAL_KNOWN_ISSUES.md.

## Requirements

- A recent Chromium-based browser (WebCodecs, OffscreenCanvas, WebGPU optional).
- Node ≥ 22.12 for the server, with `yt-dlp` and `ffmpeg` on PATH for link transcription.
