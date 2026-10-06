# Phase 12 — Captions & Subtitles: Architecture

Status: implemented and verified (see `CAPTIONS_TEST_REPORT.md`). Builds on the timeline, the Text Engine (Phase 6), the keyframe engine (Phase 8), the audio engine (Phase 11) and the existing in-browser speech-to-text. No existing system is redesigned or duplicated.

## 0. Inspection: what existed

- **The older Video Editor tool has captions:** a CSS overlay plus ffmpeg drawtext export, `lib/captions/*` types and presets, a simple SRT/VTT parser, and Whisper ASR (`auto-caption.ts`). It works on *seconds over one video*, not on the multi-track composition timeline. **Left untouched.**
- **The composition engine has a Text Engine:** `TextStyle`, `layoutText` with an injected measurer, a draw path, inline editing, and a reserved `runs` field for per-word styling. **Captions must render through it, not beside it.**
- **ASR:** `transcribeWords(file)` decoded a file at 16 kHz internally. **Refactored minimally:** its core is now `transcribeAudio16k(pcm)`, which `transcribeWords` still calls. The old tool's behavior is unchanged.

## 1. Pipeline

```
Audio (timeline mix, Phase 11 mixer — honors mute/solo; or one clip's track, soloed)
 → 16 kHz mono (toMono16k)
 → Speech-to-text (Whisper, in-browser: transcribeAudio16k)
 → Word timestamps (timeline seconds)
 → Caption segments (segmentWords: sentences, pauses, length/word/duration limits, min on-screen time)
 → Caption clips on a caption track (importCaptionCues)
 → Timeline (move/trim/split/undo… generic ops)
 → resolveFrame: caption clip → TEXT layer (track style → TextStyle) → Text Engine layout
 → drawResolvedFrame (text path) → preview and final render
```

Captioning the *timeline mix* means word times are timeline times: captions land where the speech actually plays, however the clips are arranged.

## 2. Data model

**A caption track is `Track.kind = "caption"`. Each segment is a clip** with `content.kind = "caption"`:

```ts
{ kind: "caption", text, durationFrames, words?: { text, start, end }[] /* s, clip-relative */, speaker?: string }
Track.caption?: { style: CaptionStyleSettings, presetId?, language?, speakerColors?: Record<speaker, color> }
```

Why clips:
- move, trim, split, delete, duplicate, snapping, undo, transitions (caption fade-ins), effects and keyframes (animated captions) all apply to captions without new code.
- Tracks stay non-overlapping, which is exactly the subtitle invariant.

Why track-level style:
- One edit restyles every caption, which is how subtitle styling works.
- A segment can still be placed individually through its own `clip.visual`. A canvas drag uses the ordinary transform system.

`CaptionStyleSettings`:

| Group | Fields |
|---|---|
| Typography | font (registry id), size, weight, italic, color, uppercase, line height, letter spacing |
| Stroke | stroke, color, width |
| Background | background, color, opacity, padding, radius |
| Other | shadow |
| Alignment | left / center / right |
| Position | x, y (fraction of the frame) and anchor (top / middle / bottom: the edge that sits on y, so bottom captions grow upward) |
| Wrap | max width (fraction) |
| Reserved | `highlightColor`, `animation`, kept and round-tripped for future renderers |

Word times are stored at millisecond precision, so no float noise accumulates through edits.

## 3. Segmentation

- **`segmentWords(words, profile)`** is pure. A new caption starts at:
  - a sentence end;
  - a pause of at least the profile's pause length;
  - or when the caption would exceed its characters, words or duration limit.
- A minimum on-screen time extends a caption into the following gap, never into the next caption.
- **Profiles:**
  - `subtitle`: up to 84 chars (≈ 2 lines), 16 words, 6 s.
  - `short-form`: up to 24 chars, 4 words, 2.2 s; the creator style.

## 4. Rendering = the Text Engine

`resolveClip` has a `caption` branch:
- It builds `{ text: captionDisplayText(text, style), textStyle: captionTextStyle(style, comp, speakerColor) }`, cached per content, settings and composition width.
- It passes that to the **same `cachedTextLayout`** text layers use, producing an ordinary `{type: "text"}` layer.
- Placement is `clipBaseVisual()`: the clip's own visual if it was placed individually, else `captionDefaultVisual(trackStyle)`. That default is the anchor from alignment plus vertical anchor, positioned at (x, y).

There is no caption-specific drawing code. A unit test asserts that a caption's layout `toEqual`s `layoutText(sameText, sameStyle)`, and the recording-canvas draw test sees the text path's `fillText`.

- **Inline editing:** double-click or Enter on a caption reuses the text layer's `TextEditOverlay`; empty text deletes the caption.
- **Animated captions:** the first keyframe on a caption makes its placement concrete (`withConcreteVisual`), so it doesn't jump to the frame center.

## 5. Subtitle files (`captions/subtitle-io.ts`)

**Parsing (`parseSubtitles`)** is lenient about real-world files and reports what it drops:

| Handled | How |
|---|---|
| File quirks | BOM, CRLF, missing SRT indices, `,` or `.` milliseconds, hour-less VTT stamps |
| Markup | `<i>`/`<b>`/`<c.x>` tags, ASS `{\an8}` overrides and HTML entities are stripped |
| VTT blocks | `WEBVTT` header metadata, NOTE / STYLE / REGION blocks, cue ids and cue settings are skipped |
| VTT voices | `<v Name>` becomes the speaker |
| VTT inline timestamps | `<00:00:05.500>` becomes per-word timing |
| SRT speakers | the SDH convention `NAME: text` (upper-case name) becomes the speaker. "Note: …" stays text |
| Bad timing | invalid or backwards timing: that block is skipped with a warning |

**Export:**
- `toSrt`: speakers as upper-cased `NAME:`.
- `toVtt`: `<v Name>`, optional `Language:` header, and optional inline word timestamps (karaoke VTT).
- Both round-trip through the parser.

**Placement on import** (`importCaptionCues`):
- Times are rounded to frames.
- Overlapping cues, legal in files but impossible on a track, are trimmed to end where the next starts.
- Cues starting on the same frame are placed back to back.
- Zero-length cues are widened to 1 frame.
- Every adjustment is counted and reported to the user.

## 6. Operations (pure, one undo step each)

| Operation | Purpose |
|---|---|
| `addCaptionTrack` | Adds a caption track at the front |
| `importCaptionCues(cues, {target?})` | New track, or replace a track's contents |
| `captionCuesOf(trackId)` | Export |
| `updateCaptionText` | Manual correction. Word timings carry over word-for-word when the word count is unchanged (typo fixes keep exact timing), otherwise they're re-spread. Empty text is rejected (delete instead) |
| `setCaptionSpeaker` | Set or clear the speaker |
| `setCaptionWords` | Replace word timings |
| `setCaptionTiming(clip, start, end)` | Atomic trim of both edges |
| `setCaptionTrackSettings` | Style patch; makes the preset "Custom" |
| `applyCaptionPreset` | Apply a styling preset |
| `mergeCaptionWithNext` | Join a caption with the next one |

**Generic ops made caption-aware:**
- `splitClip` splits the *words* at the cut, by timing when available.
- `trimClip` (start) shifts word timings so each word stays on its timeline moment.
- Keyframe ops make placement concrete first.

## 7. UI (composition playground)

**CaptionsPanel:**
- **Generate:** language, model (Fast / Balanced), pacing (subtitle / short-form), source (whole timeline audio / selected clip only), replace-or-new-track, with progress.
- **Import** SRT/VTT. **Export** SRT, VTT, or VTT with word timings.
- **Styling:**
  - Preset select and font.
  - Size and weight.
  - Color and uppercase.
  - Stroke: on, color, width.
  - Background: on, color, opacity.
  - Alignment buttons.
  - X, Y and max width.
  - Anchor.
  - Per-speaker colors.
- **Segment list:** start/end fields, speaker field, text area, split at playhead, merge with next, delete, click to seek and select. The caption under the playhead is highlighted.

**Elsewhere:**
- **Timeline:** fuchsia caption clips labeled "Speaker: text"; caption tracks get no ＋ transition buttons, to avoid clutter.
- **Canvas:** double-click a caption to correct it in place; drag a caption to place it individually.
- **Presets** (8): Classic subtitle, Clean outline, Cinema yellow, Boxed white, Big & bold, News lower third, Top caption, Karaoke-ready.

## 8. Persistence

Project format **v9**:
- Caption clips: text required; words validated (finite, non-negative, start ≤ end, sorted); speaker must be a string.
- Caption tracks: settings normalized. Caption settings on a non-caption track are rejected.
- v1–v8 projects load unchanged.

## 9. Future compatibility (word highlighting, animated captions, per-word timing, kinetic typography)

- **Per-word timing** is already first-class: stored, edited consistently by every op, imported from VTT inline stamps, exported to karaoke VTT, and saved.
- **`activeWordIndex(words, t)`** is implemented and tested for highlighting.
- **Rendering hook:** a highlight renderer adds style *runs* to the Text Engine (the `runs` field reserved in `TextStyle`), driven by `activeWordIndex`. `highlightColor` and `animation` are already stored on the track style.
- **Animated captions** work today through keyframes, effects and transitions on caption clips.
- **Kinetic typography** needs per-word layout boxes. These can come from the same `TextLayout` lines plus the measurer, with no new text renderer.

## 10. Out of scope / not supported

- **Automatic speaker diarization:** Whisper doesn't provide it. Speakers are assigned manually, or imported from VTT/SRT.
- **Approximate word timestamps from ASR:** the ONNX Whisper exports give phrase-level chunks; words are interpolated within each chunk, which is the existing behavior.
- Burned-in caption rendering of word highlighting.
- Positioning cue settings from VTT (`line:`, `position:`) are not mapped to placement.
- Translation.
