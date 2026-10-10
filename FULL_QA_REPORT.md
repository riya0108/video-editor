# Phase 19 — Full Real-World QA Report

Date: 2026-10-10. Feature development was frozen for this phase. Code changed only to fix:

- the one P0 found (WebM video import);
- one regression from Phase 18 (the exact-frame decoder on truncated files).

Companion documents: `KNOWN_ISSUES.md` (every issue, P0–P3) and `RELEASE_BLOCKERS.md`.

## 1. Method

| | |
|---|---|
| App | `/tools/video/composition-preview` on `astro dev`, Phase 18 code + the Phase 19 fixes |
| Browser | Chrome 154, macOS (8-core Intel, 8 GB), driven through chrome-devtools |
| Media | Real footage (a talking-head phone video, office/person photos, speech, music, a podcast) plus synthetic stress files; every file is in `.tmp-test-assets/` |
| Harness | `src/lib/qa/qa-harness.ts`, `projects.ts`, `edge-cases.ts`. These drive the **live editor through its own code paths**, never re-implementations: <br>• **Import:** the editor's upload function, with real `FileSystemFileHandle`s from the Origin Private File System, standing in for user-picked files. <br>• **Edits:** the timeline engine plus the editor's `apply`. <br>• **Background removal:** the editor's own action. <br>• **Auto-captions:** the editor's Whisper action. <br>• **AI:** the AI session, with results applied exactly as the AI panel's buttons apply them. <br>• **Save:** the production file target. <br>• **Close:** a real page reload. <br>• **Reopen:** `ProjectManager.openFile`. <br>• **Render:** the production `FinalRenderer`. <br>• **Export:** the production render job, with in-app validation that reads the written file back. |
| Independent checks | ffprobe on every exported file. Pixel/alpha inspection with ffmpeg. A visual contact sheet per project (`.tmp-test-assets/phase19/pN-sheet.png`). |

**Pipeline per project:**

1. **Import:** real files, real handles.
2. **Edit.**
3. **Preview:** every checked frame rendered until its media decoded; no layer may be skipped or missing.
4. **Save:** Save As to a `.clipbench` file.
5. **Close:** page reload, discarding all memory.
6. **Reopen:** open the file. Every asset must resolve; the reopened document is diffed field by field against the document stored in the file; full-resolution final frames are SHA-256-compared with those rendered before saving.
7. **Render and export:** the project's delivery preset, the in-app validation report, then ffprobe.

## 2. The ten projects

| # | Project | Size | What it exercises | Import | Preview | Save | Reopen | Render (frames vs saved) | Export | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Talking-head Reel | 1080×1920 | Phone video + music; jump cut (split/delete/move); punch-in zoom keyframes; contrast + saturation; title (emoji, stroke); lower third; music fades | 2 files, 205 ms, 0 errors | 5/5 frames, 0 skipped | 31 ms, 6.5 KB | 219 ms, 2/2 assets OK, document identical | 5/5 bit-identical | Reel preset MP4, 600 frames, **valid** (25.2 s) | ✅ |
| 2 | Finance explainer | 1920×1080 | Narration + 2 B-roll clips with a wipe; 5 bar shapes with keyframed growth; 5 labels; headline; **SVG** icon with rotation keys; narration gain/fade | 4 files, 0 errors | 6/6 | 41 ms, 15.9 KB | 287 ms, 3/3, identical | 6/6 | YouTube MP4, **valid** (4.9 s); correct clipping warning | ✅ |
| 3 | Product advertisement | 1080×1080 | Product PNG (alpha) with scale/rotation keys + glow; backdrop with blur + vignette; push transition between callouts; shadowed CTA; music + SFX | 4 files, 0 errors | 6/6 | 32 ms, 8.4 KB | 213 ms, 4/4, identical | 6/6 | Square MP4, **valid**; slow (30.7 s for 6 s → P2-1) | ✅ |
| 4 | Background-removal Reel | 1080×1920 | **U²-Net** on a person photo (3.2 s); **per-frame matte on the 8 s talking-head video** (28.3 s); composited over an office backdrop | 3 files, 0 errors | 4/4 | 133 ms, **5.5 MB** (matte PNGs embedded) | 324 ms, 5/5, identical | 4/4 | Reel MP4, **valid** (18.5 s). Matte verified: 19–28 % of the video's frame transparent | ✅ |
| 5 | Caption-heavy Reel | 1080×1920 | **Whisper auto-captions** (8 captions in 2.8 s, accurate text); "creator" preset; a 150-block SRT (149 cues + 1 malformed block skipped with a warning); a messy SRT; a speakers VTT; 4 caption tracks, 163 clips | 1 file + 3 subtitle files | 6/6 | 21 ms, 33 KB | 170 ms, 1/1, identical | 6/6 | Shorts MP4, **4 min 30 s, 8,099 frames, valid** (42.5 s); correct "Shorts ≤ 3 min" warning | ✅ |
| 6 | Podcast clip | 1080×1080 | **31-min WAV refused** (30-min limit → P1-3); 25-min cut imported (0.7 s); 60 s segment cut from minute 12; interview after it; cover image + exposure; title; keyframed progress bar; AI speaker detection (4 segments) | 0.7 s, 1 expected refusal | 4/4 | 29 ms, 6.4 KB | 817 ms, 3/3, identical | 4/4 | Square MP4, 83.7 s, **valid**; slow (138.6 s → P2-1) | ✅ (with P1-3) |
| 7 | Music montage | 1920×1080 | 9 clips cut to the beat on one track; **all 8 transition types**; temperature + contrast + grain on every shot (27 effects); music + ambience | 11 files, 0 errors | 7/7 | 27 ms, 13.5 KB | 366 ms, 11/11, identical | 7/7 | YouTube MP4 written (324 frames, all technical checks OK), but **in-app validation FAILS**: fidelity 21.7 dB at the dither "Dissolve" → **P1-1** | ❌ P1-1 |
| 8 | Image slideshow | 1920×1080 | 12 images (PNG, JPG, WebP; one with alpha); Ken Burns (scale + pan keys, 72 keys); 11 cross-dissolves; music fades | 13 files, 0 errors | 6/6 | 45 ms, 20 KB | 388 ms, 13/13, identical | 6/6 | YouTube MP4, **valid** (6.6 s) | ✅ |
| 9 | Multi-layer composition (transparent) | 1920×1080, transparent | 32 tracks: 20 shapes in **all 17 blend modes**; **960 keyframes**; **all 4 mask types** (rectangle, ellipse feathered, polygon, freeform) with add/subtract modes; a 6-effect stack; **alpha WebM**; alpha PNGs; SVG; **7 audio tracks** (mute, gain, fades), incl. an audio-only WebM | 12 files, 0 errors (after the P0-1 fix) | 5/5 | 105 ms, 104 KB | 618 ms, 11/11, identical | 5/5 | **WebM VP9 + alpha + Opus, valid**; `alpha_mode=1`; 54.6 % of frame 75 fully transparent | ✅ (after P0-1 fix) |
| 10 | AI-assisted project | 1080×1920 | Landscape multi-shot video in 9:16. AI features, each **applied** to the timeline: <br>• **shot detection** → split into 4 clips <br>• **face detection** <br>• **auto-reframe** → position keys <br>• **filler-word detection** → 3 cuts, gaps closed <br>• **silence detection** → 2 cuts, gaps closed <br>• **highlight detection** | 3 files, 0 errors | 4/4 | 34 ms, 17 KB | 214 ms, 3/3, identical | 4/4 | Shorts MP4, **valid** (2.6 s) | ✅ |

Totals: 10 projects; 9 end-to-end passes; 1 export flagged by validation (P1-1). Every save/close/reopen round trip produced an **identical document and bit-identical frames**. **No crash, hang or uncaught error** came from the app.

## 3. Edge cases

### 3.1 Corrupted and unsupported media (imported one by one through the editor's upload path)

| File | Time | Outcome |
|---|---|---|
| `garbage.mp4` (random bytes) | 91 ms | Refused with a message; no clip. The message blames a missing codec and includes Chrome's internal error (P3-4) |
| `zero-byte.mp4` | 53 ms | "That file is empty." |
| `fake-video.mp4` (a PNG renamed) | 54 ms | Refused (same message as garbage, P3-4) |
| `corrupted.mp3` | 73 ms | Refused: "couldn't decode the audio… may be corrupted…" |
| `truncated.wav` | 94 ms | Imported, with a precise warning: "header says 10.0 s but only 0.5 s of audio is present" |
| `legacy.wma` | 52 ms | Refused: "can't be decoded in a browser. Convert it…" |
| `heavy-150.srt` dropped on the media area | 53 ms | Refused as "not an image or video" (P3-5: subtitles go through the Captions panel) |
| `long.txt` | 54 ms | Refused |
| `truncated-video.mp4` (first 12 MB of a 58 MB file whose header says 60 s) | 114 ms | **Imported without a warning.** The picture holds the last decodable frame after about 12 s; the soundtrack is silently reported as "no audio" (P2-2). Before the fix, its export took **> 150 s** (P2-3, a Phase 18 regression, **fixed**: now 9.3 s, valid). |

The editor stayed fully usable after every refusal. The console showed no errors.

### 3.2 Missing media and relink

| Step | Result |
|---|---|
| Save a 3-asset project, then delete the image and the audio file from disk | — |
| Reopen | `s1.mp4` OK; logo and SFX **missing**. UI: "2 media item(s) unavailable — the timeline keeps their clips; they render once relinked" + "Relink…" buttons |
| Preview while missing | Renders, without the missing image; other layers fine |
| Export while missing | **Refused** immediately: "Audio for whoosh-sfx.wav isn't available (missing)" |
| Relink both (`manager.relink`, the path the Relink button takes) | `exact` matches, 55 ms / 167 ms |
| After relink | Frames **bit-identical** to the original save; export **valid** |

### 3.3 Long video — 10 min, 1080p30 H.264 + AAC, 158 MB

| Step | Result |
|---|---|
| Import | 21 ms; 10-minute soundtrack decoded in 0.48 s |
| Scrub (random frames across 10 min) | 61–68 ms to an exact frame |
| Save / reopen | 37 ms / 750 ms; frames bit-identical |
| Export, all 18,000 frames | **Valid**, 609 MB, 107 s (5.6× realtime) |
| Memory | JS heap **peaked at about 2.3 GB** (the output is held in memory: P1-2); back to 164 MB afterwards, so no leak |

### 3.4 Large project — 61 tracks, 601 clips, 3,000 keyframes

| Step | Result |
|---|---|
| Build | 81 ms |
| 40 undo/redo steps | 1 ms |
| Save | 128 ms, 677 KB |
| Reopen | 442 ms; frames bit-identical |
| Export (60 s) | Valid, 9.8 s |
| UI, development build | Edit → painted frame 20–40 ms (first 128 ms); playback 48.8 fps with 8 long tasks (P3-8) |

### 3.5 Export variants (Project 1) and cancellation

All **11 variants pass** in-app validation:

| Variant | Time |
|---|---|
| MOV H.264 | 23.9 s |
| MP4 HEVC | 23.7 s |
| MP4 AV1 | 23.9 s |
| WebM VP9 + Opus | 24.5 s |
| WebM VP8 + Opus | 27.3 s |
| 4K 2160×3840 | 96.3 s |
| 60 fps (1,200 frames) | 48.5 s |
| 720p | 10.7 s |
| Fit → 1920×1080 letterbox | 9.2 s |
| Fill → square crop | 23.9 s |
| No audio | 24.5 s |

The letterbox and crop exports each warned accurately, e.g. "scaled to 608×1080 and centred… black bars" and "840 px are cut off top and bottom".

**Cancel at 30 %:** `AbortError: Render cancelled` after 5.4 s. The next export after cancelling was valid.

### 3.6 Coverage of the requested areas

| Area | Where tested | Result |
|---|---|---|
| Crashes | All runs (≈ 40 page sessions). Crash *recovery* (renderer killed) was verified in Phase 17 | No crash, freeze or uncaught error caused by the app |
| Corrupted media | §3.1 | Handled; P2-2, P3-4 |
| Missing media | §3.2 | Handled correctly |
| Long videos | §3.3; 4.5-min export (P5); 25-min audio (P6) | Works; P1-2 memory; P1-3 31-min audio |
| Large projects | §3.4; P5 (163 clips), P9 (32 tracks) | Works |
| Many layers | P9, §3.4 | Works |
| Many keyframes | P9 (960), §3.4 (3,000) | Works |
| Multiple effects | P7 (27), P9 (6-stack), P3 | Works; P2-1 export speed |
| Multiple audio tracks | P9 (7), P3, P6 | Works; mix clipping warnings correct |
| Captions | P5 (Whisper, SRT, VTT, presets, 4 tracks) | Works; P3-3 |
| Masks | P9 (all 4 types, feather, modes) | Works |
| Background removal | P4 (photo + video), P9 | Works |
| Transparent assets | P9 (alpha WebM, alpha PNGs, transparent export), P3, P8 | Works after P0-1 |
| Export | All projects + 11 variants + cancel | Works; P1-1, P1-2 |

## 4. Fixes made in this phase

1. **P0-1 — WebM video imported as audio (or rejected).**
   - Cause: `.webm` is in the audio extension list, which matched even for `video/webm` files. A WebM with sound lost its picture; one without sound was refused with an audio error.
   - Fix: `refineImportKind` (`src/lib/composition/media-import.ts`). A `.webm`/`.ogg` not labelled `audio/*` is probed once for a video track; audio-only files stay audio.
   - Verified: unit tests +5; live, `alpha.webm` imports as a video layer and `voice-memo.webm` (Opus only) as audio.
   - Also found and fixed while verifying: the first version of the probe read `videoWidth` after resetting the element, so it always said "no video".
2. **P2-3 — export ~15× slower past the end of a truncated file.**
   - Cause: a Phase 18 regression. `SequentialFrameCursor` restarted the decoder for every frame requested past the end of a finished stream.
   - Fix: it now holds the last frame.
   - Verified: unit test +1; live, 1,800 frames went from > 150 s to 9.3 s, and the export is valid.

Unit tests after the fixes: **1210 passed** (+18 since Phase 18), 34 skipped. `tsc`: 0 errors.

## 5. Things that looked like bugs and weren't (investigated, documented so they aren't re-reported)

- **P3 frame 0 "sharper":** frame 0 looked crisper in the contact sheet. Measured, it was identical in sharpness to every other frame (gradient 0.38); later frames only *look* softer under the product's translucent full-frame red.
- **P9 "vanishing video":** constant coverage. The project's own subtract mask hides the layer; the block that disappears is the 2 s alpha WebM ending.
- **P10 extreme crop:** the source shot is already a tight close-up; auto-reframe centred the face correctly.
- **A 1-frame audio sliver after silence removal:** produced by the QA helper trimming a clip that started past the picture end. Not reachable from the UI.
- **150-cue SRT importing 149:** my generator wrote an invalid timestamp (`08,1000`); the parser correctly skipped that block with a warning.
- **Test-tool artifacts, not app behaviour:**
  - Long `evaluate_script` calls hit the devtools protocol timeout. A long run was re-done as a background job and polled.
  - A run stalled while a leftover `beforeunload` dialog was open.
  - A hidden tab was frozen by Chrome (its clock stopped). Measurements were re-taken in the foreground.
