# Phase 11 — Audio Engine: Test Report

Date: 2026-10-03.

Environment:
- macOS, Node 22, Vitest 5.
- Chrome via chrome-devtools-mcp, real Web Audio output device.
- Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **868 / 868 passed** (79 files) |
| New audio suite (`src/lib/audio/audio-engine.test.ts`) | **25 / 25 passed** |
| Type checking (`tsc --noEmit`) | **exit 0** |
| `astro check` | **0 errors, 0 warnings**; no hints in Phase 11 files |
| Lint | No linter is configured in this repo; `tsc` + `astro check` are the static checks |
| Production build | **Complete** |
| Browser console during all live tests | **0 errors / 0 warnings** |

**Changed pre-existing test:** `media-import.test.ts` asserted that audio files are *rejected* ("audio arrives in a later phase"). That contract intentionally changed. The test now asserts that audio is accepted, that WMA is refused with a conversion hint, and that empty files are refused.

**Mutation checks** — each caught by at least one test, then reverted:
- Ignore the mid-clip source offset.
- Ignore solo.
- Drop normalization gain.
- Split leaving the fade-out on the left piece.

## Test assets (generated, `.tmp-test-assets/phase11/`)

| File | Content |
|---|---|
| `epic-music.mp3` (also `.wav`) | 20 s chord progression, peak −12.4 dBFS |
| `narration-voiceover.m4a` | AAC voiceover recorded with macOS `say` |
| `whoosh-sfx.wav` | click burst at **exactly 0.500 s**, whoosh tail |
| `rain-ambience.flac` | 30 s noise ambience |
| `corrupted.mp3` | random bytes |
| `truncated.wav` | header claims 10 s, holds 0.5 s |
| `legacy.wma` | unsupported format |
| `alac-voice.m4a` | ALAC codec in a supported container |
| `long-podcast-31min.wav` | 31-minute file |

## Automated (Node)

**Model:**
- Defaults; clamping (volume 9→2, gain −500→−60, fades rounded/non-negative, bad curve/mute values ignored).
- dB↔linear conversion.
- The three fade curves at exact values.
- Fade gain at 0/5/50/90/100 frames, and over-long fades scaling on a trimmed clip.
- Normalization math (target − peak); silence refused; target clamped.
- Role guessing for music, voiceover, SFX and ambient.

**Operations:**
- `setClipAudio` on audio and video clips; rejected on images; NaN rejected.
- **Volume automation:**
  - Keys 0→1 give 0.5 at the midpoint.
  - Auto-key on an edit at the playhead keeps the base value.
  - Gain automation.
  - Picture paths refused on audio clips; audio paths refused on images.
- **Fade automation:** fade-in × volume key = 0.25 at the expected sample; full envelope endpoints checked.
- **Trim / split / move / duplicate:**
  - The split mix is **identical** to the unsplit mix at 5 probe times, including either side of the cut.
  - After a move, source time 1.75 s plays at the moved position (gain-exact).
  - After a start-trim, timeline-aligned samples are unchanged.
  - Duplicate copies the audio settings.
- **Normalize:**
  - The measured peak (−12.04 dB for a 0.25 sine) gives make-up gain, and the mix peak lands at **−1.00 dBFS**.
  - Undo/redo across normalize → volume → remove normalization.
  - A silent clip is rejected.

**Mixing (exact samples):**
- **Music + voiceover + SFX + ambient on 4 tracks:** sum 0.65; with music volume 0.5 and SFX +6.02 dB the sum is exactly 0.9.
- **Mute / solo:**
  - Track mute.
  - Solo (only the soloed track sounds).
  - Un-solo restores everything.
  - Clip mute.
- **Sync:**
  - A click at source 0.75 s, on a clip at 1 s with in-point 0.5 s, lands at **sample 1250 of 1000 Hz** (1.25 s).
  - Rendering from mid-clip (1.1 s) lands it at the same timeline time.
  - Segment offset is 0.6 s.
- **Resampling:** a 250 Hz source at a 1000 Hz output keeps time (0.5 at sample 500).
- **Sources:**
  - A video soundtrack mixes in.
  - A missing or no-audio source is silent.
  - A muted video soundtrack is excluded.
  - A source shorter than its clip gives silence, not garbage.
- **Clipping:** reported (peak 1.4, 2000 clipped samples).

**Waveform, levels, WAV:**
- Exact per-bin min/max; column reduction.
- Peak over a trimmed range only; silence gives −∞.
- 16-bit WAV round trip within quantization; overs clamped.

**Safety:**
- **File checks:** MP3/FLAC accepted; WMA refused (unsupported); empty refused; 600 MB refused.
- **Duration/budget from metadata:** a file over 30 min is refused (too-long); one that would exceed the memory budget is refused (over-budget); NaN or Infinite duration is refused (no-duration).
- **Decoder error classification:** EncodingError → unsupported-codec; timeout; other → corrupted.
- **Truncated audio:**
  - A truncated decode is detected.
  - A truncated WAV header is detected (1 s declared, 0.25 s present).
  - A non-WAV file is ignored.

**Persistence (v8):**
- Round trip of settings, role, normalization, automation, track mute and solo. The **mix after reload is bit-identical**.
- Rejected: picture animation on an audio clip, audio settings on an image, a non-object audio value.
- v7 files load with defaults.

## Live (Chrome, real decode and Web Audio)

**Import (real file picker, 9 files at once):**
- Music MP3, voiceover AAC, SFX WAV and ambient FLAC all decoded; their roles were guessed; each got its own track and waveform.
- The demo video's own soundtrack decoded (8 s, 48 kHz stereo).

| File | Result |
|---|---|
| `corrupted.mp3` | "couldn't decode … may be corrupted, or use a codec your browser lacks" |
| `legacy.wma` | "can't be decoded in a browser. Convert it to MP3, WAV…" (refused before reading) |
| `long-podcast-31min.wav` | "31 minutes is longer than the 30-minute limit… Split it" (refused from metadata, nothing decoded) |
| `alac-voice.m4a` | unsupported codec message (Chrome can't decode ALAC) |
| `truncated.wav` | **Bug found:** at first it loaded silently as 0.5 s. **Fixed:** it now loads with "header says 10.0 s but only 0.5 s of audio is present" (see Bugs) |

**Audio panel (real fields and buttons) on the music clip:**
- Peak read **−12.4 dBFS**.
- Fade in 1 s and fade out 2 s were stored as 30 and 60 frames.
- **Normalize** stored +11.4 dB, with the readout "Normalized to −1 dB (+11.4 dB)".

**Ducking automation:** volume keys at 1 s / 1.5 s / 5 s / 5.5 s are visible as diamonds on the clip and in the Keyframes panel.

**Waveform:** visible on every audio clip, shaped by gain, with the envelope line showing the fades and the duck (screenshot).

**Sync (export path):**
- The SFX track was soloed with the real **S** button and the SFX clip moved to 2 s.
- The click landed at **sample 120000 = exactly 2.500 s** at 48 kHz.
- Nothing sounded before 2 s, so the other tracks were silenced by solo.

**Playback = export (the strongest check):**
- The live playback graph (`scheduleTimeline`) was rendered in an `OfflineAudioContext` and compared with the exporter for 10 s of the full 6-source mix.
- **Max difference 2.4e-7 (float precision), SNR 145.5 dB.**
- Starting playback mid-timeline at 2.2 s: **max difference 1.2e-7**.

**Playback (real Play click):**
- The AudioContext was `running`, with 5 sources scheduled. The audio clock advanced at exactly real time (7.5 frames per 250 ms at 30 fps).
- In the foreground, the displayed frame stayed **0.5–1.5 frames behind the audio clock** (40 rAF samples), i.e. under 50 ms.
- In a background tab Chrome throttles rAF to about 1 Hz. The display then steps, but stays on the audio clock.

**Edits during playback:**
- Track mute through the M button re-schedules immediately (5 → 1 sources at 25 s, the correct set).
- Before the fix the clock paused about 80 ms per edit. After it, the clock went **124.90 → 125.06 frames across the edit** (5 ms elapsed) and kept advancing smoothly.

**Export (button):**
- WAV of 30 s at 48 kHz in 80 ms; later 10.17 s in 41 ms.
- It **warned about clipping** (the summed mix exceeded 0 dBFS) instead of hiding it.
- The inline player and Download work.

**Save → page reload → Load:**
- The notice listed all 4 audio files as missing.
- All 5 audio clips (the ambient was split) were drawn red, marked "missing".
- **Export refused** with the list of clips.
- The panel said "Missing audio … Re-add the file to relink it".
- Re-adding the same 4 files **relinked in place** (no duplicate clips): "Relinked missing audio: …", all 5 clips ready, waveforms back.
- **Mix checksum identical to before the save** (−1005206674 both).

## Bugs found during Phase 11

1. **Truncated WAV accepted silently (fixed).** Chrome reports a truncated WAV's *present* length as its duration, so the "decoded much shorter than claimed" check couldn't see it. Added a WAV header check (`wavTruncation`): the file loads with a visible warning in the import banner and the Audio panel. Unit test added.
2. **"Re-add to relink" promised relinking that didn't exist (fixed for audio).** Re-adding a file created a new clip. Audio is now relinked by file name into the existing source id.
3. **Playback hitch on every edit while playing (fixed).** Re-scheduling restarted the clock with a clamp, holding the playhead about 80 ms. Re-scheduling is now continuous.
4. **Frozen picture if the audio clock can't start (prevented).** An autoplay-blocked AudioContext never advances. Playback now falls back to the wall clock unless `clockRunning`.
5. **UI fixes:**
   - The Keyframes panel value field was 20 px wide, so "60%" read "6%". Grid fixed.
   - Audio rows were too short for waveforms (now 44 px), and labels were unreadable over the envelope (now on a backing).
   - The timeline's scroll area hid audio rows.
   - The Keyframes hint referred only to "Transform".

## Known issues / limitations

- **Peak normalization only**, not LUFS loudness.
- **Long files:** over 30 min are refused rather than streamed. Total decoded audio is capped at 1.5 GB per session.
- **Export runs on the main thread:** about 2–3 ms per timeline second with 6 sources, so long timelines briefly block the UI. Export is audio-only (WAV); muxing with picture is not built.
- **Relink matches by file name;** a renamed file must be re-added as a new clip.
- **Video soundtracks:** decoded with the same 30-minute / budget limits. A video too long for that plays picture without sound and shows an error status.
- **Not built:** panning, per-track bus volume, audio effects, audio crossfade transitions.
