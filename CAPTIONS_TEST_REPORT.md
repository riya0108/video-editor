# Phase 12 — Captions & Subtitles: Test Report

Date: 2026-10-03.

Environment:
- macOS, Node 22, Vitest 5.
- Chrome via chrome-devtools-mcp, real in-browser Whisper (onnx-community whisper-tiny, q4).
- Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **890 / 890 passed** (80 files) |
| New captions suite (`src/lib/captions/captions.test.ts`) | **22 / 22 passed** |
| Type checking (`tsc --noEmit`) | **exit 0** |
| `astro check` | **0 errors, 0 warnings**; one new hint (an unused import I introduced) was removed, back to the 15 pre-existing hints |
| Lint | No linter is configured in this repo; `tsc` + `astro check` are the static checks |
| Production build | **Complete** |
| Browser console during all live tests | **0 errors / 0 warnings** |

**Mutation checks** — each caught, then reverted:
- Trim not shifting words.
- Import not separating same-frame starts. This one first **survived**; a missing test case was added and it is now caught.
- Uppercase ignored at render.
- Backwards cues accepted.

## Test media (generated, `.tmp-test-assets/phase12/`)

| File | Content |
|---|---|
| `short-speech.m4a` | 3.5 s, macOS `say` |
| `long-speech-x4.m4a` | **3 min 25 s** (≈ 664 words) |
| `two-speakers.wav` | two `say` voices, Samantha then Daniel |
| `messy.srt` | BOM, CRLF, `<i>`, `{\an8}`, `&amp;`, overlap, backwards cue, garbage block, SDH speaker |
| `speakers.vtt` | header metadata, NOTE, cue settings, hour-less stamps, `<v>` voices, inline word timestamps |

## Automated (Node)

**SRT/VTT:**
- Messy SRT parses to exactly 3 cues (multi-line kept, tags/overrides/entities stripped, `JOHN:` speaker, "Note:" kept as text), with warnings for the backwards cue and the garbage block.
- VTT: voices become speakers, the hour stamp (01:00:02.5) parses, inline stamps become exact word timings.
- Stamp formatting/parsing to the millisecond, with invalid minutes rejected.
- SRT and VTT (with words) **round trips**.

**Segmentation:**
- Sentence and pause splits.
- Short-form 4-word pacing.
- Minimum duration never overlaps the next caption.
- **2000-word long speech:** no word lost or reordered, no overlaps, every caption within the character limit.
- 48 kHz stereo → 16 kHz mono resampling is exact.

**Model:**
- Style clamping; all 8 presets are valid.
- TextStyle mapping (wrap width = maxWidth × width − padding; speaker color).
- Bottom/top/left anchor placement.
- **Manual-correction word timing:** same word count keeps exact timings; a different count re-spreads them.
- Split by timing and by proportional boundary; active word lookup.

**Timeline:**
- Import onto a new front track, frame-accurate, overlap trimmed and counted; export equals input.
- Same-frame starts placed back to back.
- **Word timings through move / trim / split / merge** stay on their timeline moments.
- Text correction, empty text rejected, speaker set/clear, restyle, preset (speaker colors kept), "Custom" after hand-tuning.
- Typed rejections: wrong track kind, missing clip, caption on a video track.

**Renderer (Text Engine reuse):**
- The caption is a `text` layer whose layout **equals** `layoutText(sameText, captionTextStyle)`.
- Uppercase shows only in the display text.
- Bottom-anchored at 90 % and centered.
- Speaker color applied.
- A track restyle moves unplaced captions; an individually placed caption keeps its spot.
- **Animated captions:** an opacity keyframe on a caption does not move it to the frame center, and it evaluates to 0.5 at the midpoint.
- The draw path calls `fillText`.

**Undo/redo:** import → edit → preset → delete; snapshots restored exactly back to before the import.

**Persistence (v9):**
- Round trip of words, speakers, preset, language, speaker colors and a per-caption placement. **Resolve is identical** at 3 frames.
- Corrupt word timings, missing text, and caption settings on a video track are rejected.
- v8 files load.

## Live (Chrome, real speech-to-text, real final renderer)

| Test | Result |
|---|---|
| **Short speech** (clip at 1.0 s, "Selected clip only", English) | "Hello and welcome, today we test automatic captions." — **word-perfect**. The caption starts at **frame 30 = 1.0 s**, the speech's timeline position. 8 timed words. |
| **Long speech** (3 min 25 s) | **65 captions, 663 words** (source ≈ 664). **0 overlaps**, longest caption 84 chars / 5.5 s. The final sentence lands at 199.4–204.4 s, the end of the audio. Transcription took 105 s for 205 s of audio (≈ 2× real time, Fast model). |
| **Multiple speakers** (two voices, short-form pacing) | 5 captions of ≤ 4 words, correctly transcribed. Whisper doesn't identify speakers; they were **assigned in the panel's Speaker fields** (Ana ×2, Daniel ×3), and a color was set for Daniel. |
| **Export** | SRT: `ANA: Hi Daniel, did you` … VTT: `<v Daniel>Almost.` … VTT + words: `<v Ana>Hi <00:00:00.152>Daniel, <00:00:00.683>did …` |
| **SRT import** (`messy.srt`, real file picker) | 3 captions. "1 overlapping/too-short cue timing adjusted", "Block 3: ends before it starts — skipped" (reported in the notice). `NARRATOR` became the speaker, `&` was decoded, two-line text kept. |
| **VTT import** (`speakers.vtt`) | 2 captions. Speakers Mia/Leo. The karaoke cue got **exact word timings** (0–0.7, 0.7–1.3, 1.3–2.0 s, clip-relative). |
| **Manual correction** (panel) | Text "Hello from Web VTT!" stored; End field 1.8 s; preset "Boxed white"; Left alignment; Y 15 %; Anchor top. |
| **Styling + positioning in the final render** | Caption box at **x = 960, y = 162**, exactly the 50 % left-aligned / 15 % top-anchored position. A pixel inside the box is pure white (255,255,255); just above the box is the scene, not white. Text color #0f172a, weight 800. The "Big & bold" preset renders in Anton, uppercase, with stroke (screenshot). |
| **Save → page reload → Load** | Generated, imported, styled and individually placed captions: **caption clips, caption tracks and 4 final-render frame checksums all identical**. The speech audio is reported missing (media is never embedded), which doesn't affect captions. |

## Bugs found during Phase 12

1. **VTT inline timestamps left in the caption text (fixed).** The tag stripper only matched tags starting with a letter, so `<00:00:05.500>` stayed in the visible text. Caught by a unit test.
2. **Float noise in word timings (fixed).** Values like 1.2000000000000002 accumulated through edits. Word times are now stored at millisecond precision everywhere.
3. **"Selected clip only" captioned other tracks too (fixed).** It limited the time range but still mixed in all tracks (here, the demo video's own speech). It now solos the selected clip's track in a derived view.
4. **Generation read render-time state (hardened).** Generation is async, so it now reads the engine's current selection and timeline rather than the render snapshot. *Found while live testing.* The first live run placed a caption at a stale position. I traced that to my test script moving the clip without re-rendering; in real use every edit re-renders, so this was not a user-facing bug. The hardening removes the dependency anyway.
5. **Preset label kept claiming a preset after hand-tuning (fixed).** It now shows "Custom".
6. **Timeline problems exposed by long captions (fixed):**
   - The ruler labeled every second, so 3.4 minutes became an unreadable smear. The step now adapts (1/2/5/10/15/30/60 s…, with m:ss labels).
   - Every caption cut got a ＋ transition button, dozens of them. Caption tracks now get none, and ＋ is hidden where clips are too narrow to click.

## Known issues / limitations

- **No automatic speaker identification (diarization):** Whisper doesn't provide it. Speakers come from manual assignment or VTT/SRT import.
- **ASR word timings are interpolated within Whisper's phrase chunks** (the ONNX exports have no word alignment). They're fine for captions and approximate for karaoke. Imported VTT word timings are exact.
- **Transcription speed:** about 2× real time with the Fast model, on the main thread with a progress display. The Balanced model is more accurate and slower.
- **SRT speaker names round-trip upper-cased** (the SDH convention); VTT keeps them exactly.
- **Imported subtitle files:**
  - VTT cue positioning settings (`line:`, `position:`) are ignored on import (track placement applies).
  - Cues starting on the same frame are placed back to back, so the second shows slightly later than authored.
- **Word highlighting / kinetic rendering** is prepared in the model but not drawn (see Architecture §9).
