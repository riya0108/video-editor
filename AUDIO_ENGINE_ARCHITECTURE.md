# Phase 11 — Audio Engine: Architecture

Status: implemented and verified (see `AUDIO_ENGINE_TEST_REPORT.md`). Builds on the timeline (tracks, clips, mute/solo flags, snapshot undo), the keyframe engine (Phase 8) and the composition playground. Nothing is redesigned; picture rendering is untouched.

## 0. Inspection: what existed

**Already present:**
- `TrackKind "audio"` and `createAudioClip` with trimmable in/out.
- `Track.muted` / `Track.solo`, with `isTrackAudible` deriving solo (never stored).
- Trim/split/move/duplicate ops are generic over clip kinds.

**Missing:**
- **Nothing played, mixed, decoded or drew audio.**
- The composition editor *rejected* audio files on import.
- The resolver skips audio tracks; that is correct, since sound is not part of picture resolution.
- Preview `<video>` elements are deliberately `muted`.

**Decision:** sound is a separate subsystem (`src/lib/audio/`) reading the same timeline. It has one pure core shared by playback and export, plus a thin browser layer (decode store, Web Audio player).

## 1. Pipeline

```
timeline (clips + clip.audio + audio.* keyframes + track mute/solo)
  └─ audioSegments()            which clips sound when, at which source offset   ┐ pure, shared
  └─ clipGainAt()/sampleEnvelope()  volume automation × gain × normalization × fades ┘
        ├─ PLAYBACK: AudioBufferSourceNode(offset) → GainNode(setValueCurveAtTime(envelope)) → master → speakers
        │            AudioContext clock = master clock; picture follows it
        └─ EXPORT:   mixTimeline() — same segments, same envelope, resampled & summed → 16-bit WAV
```

## 2. Model

`Clip.audio?: ClipAudio` applies to clips that carry sound: **audio clips and the soundtrack of video/overlay clips** (`isAudibleKind`). Undefined means defaults. All of it is non-destructive data.

| Field | Meaning |
|---|---|
| `role?` | music · voiceover · sfx · ambient · original (video sound). Guessed from the file name on import, editable |
| `volume` | linear 0–2 (mix level). **Animatable** at `audio.volume` (volume automation) |
| `gainDb` | −60…+24 dB trim. **Animatable** at `audio.gainDb` |
| `fadeInFrames` / `fadeOutFrames` + `fadeCurve` | linear / equal-power / s-curve. Fades longer than a trimmed clip scale down proportionally (stored lengths kept) |
| `muted` | clip mute (track mute/solo are the existing track flags) |
| `normalize?` | `{targetDb, peakDb, gainDb}`: peak normalization *result*, stored so a reload reproduces the mix without re-analysis |

## 3. Keyframe integration

`audio.volume` and `audio.gainDb` are entries in the Phase 8 property registry.
- Every keyframe op, easing, the Keyframes panel, persistence and undo work for them unchanged.
- `requireAnimatableClip` now checks the clip kind: `audio.*` paths are allowed on audible clips, picture paths on visual clips.
- `setClipAudio(…, frame)` **auto-keys** an animated volume/gain at the playhead, like visual edits.
- **Fade automation:** fades and volume keyframes are factors of one gain envelope (`clipGainAt`). A ducking curve (volume keys) and fade in/out compose multiplicatively. That one envelope is exactly what both playback and export apply.

## 4. Engine core (`audio/engine-core.ts`, pure)

- **`audioSegments(timeline, {fromSec, toSec, hasAudio})`:**
  - Covers every audible clip on every sound track.
  - Honors `isTrackAudible` (solo derived) and clip mute.
  - Skips sources without decoded audio.
  - Trims to the range and computes `sourceOffsetSec = in + (start − clipStart)`. This is the **sync** contract: a playback or export started mid-clip enters the source at the right sample.
- **Envelope:** `sampleEnvelope` samples at 500 Hz. Playback hands that array to `AudioParam.setValueCurveAtTime`; export interpolates it per sample, so both use the same curve.
- **`mixTimeline`** (export): per segment, linear-interpolation resampling from the source rate, multiplied by the envelope, summed into stereo (mono feeds both channels).
  - Reports `peak` and `clippedSamples` instead of hiding overs.
  - A source shorter than its clip claims yields silence, never garbage.
- **Analysis:** `computePeaks` (exact min/max per bin, 200 bins/s), `waveformColumns`, `peakDbOf` / `clipPeakDb` (trimmed range only).
- **`encodeWav16` / `decodeWav16`.**

**Playback (`audio/playback.ts`):**
- `scheduleTimeline(ctx, dest, timeline, buffers, fromSec, when)` works on any `BaseAudioContext`, so the *live graph* can be rendered offline and compared with the exporter.
- `AudioPlaybackEngine.play / update / stop / currentFrameExact`:
  - The clock is `ctx.currentTime` minus output latency.
  - `update()` (any edit while playing) re-schedules from where the clock will be once audible, without clamping, so the playhead never hitches.
  - `clockRunning` is false when the browser keeps the context suspended (autoplay policy). The playground then falls back to the wall clock rather than freezing the picture.

## 5. Operations (pure, undoable)

- `setClipAudio(clipId, patch, frame?)` covers volume, gain, fades, curve, mute, role and `normalize: null`. Values are clamped, non-finite volume/gain are rejected, and clips without sound are rejected.
- `normalizeClipAudioOp(clipId, peakDb, targetDb = −1)`: the engine measures the peak; the op stores the make-up gain. A silent clip is rejected.
- **Trim / move / duplicate:** the existing generic ops keep audio in sync, because the source offset derives from in-points.
- **Split:** the left piece keeps the fade-in and the right piece keeps the fade-out, so a split is inaudible (verified sample-for-sample).
- **Multiple tracks / mute / solo:** the existing track ops.

## 6. Safe handling (`audio/safety.ts`, `audio/source-store.ts`)

| Hazard | Handling |
|---|---|
| Unsupported format | Extension/MIME allowlist. WMA/AC-3/MIDI etc. are refused before reading, with a conversion hint |
| Unsupported codec inside a supported container (e.g. ALAC in .m4a) | The decoder's verdict, classified as `unsupported-codec`, with a message |
| Corrupted | Metadata or decode failure → `corrupted`. A decode far shorter than its container claims → refused |
| Truncated WAV (browsers silently play it short) | Header data size vs bytes present → loads with a **warning** naming the missing length |
| Very long | Duration is read from **metadata first** (no samples decoded). Over 30 min → refused. Decoded-memory budget of 1.5 GB per session. 500 MB file cap. Metadata (15 s) and decode (120 s) timeouts |
| Missing (project loaded without its media) | Status `missing`: the clip is drawn red, plays silent, the panel explains, and **export refuses with the list**. **Re-adding a file with the same name relinks it in place** |
| Video without a soundtrack | `no-audio`: silent and normal, not an error |

The store states are `loading → ready (+warning?) | no-audio | error | missing`. They are always visible in the timeline (`data-audio-state`) and the Audio panel.

## 7. UI (composition playground)

- **Import:** Add media and drag-drop accept audio. Each file gets its own audio track named "Role: file", placed at the playhead with the role set. Video uploads decode their soundtrack too.
- **Timeline:**
  - Audio rows are 44 px.
  - Each clip shows its waveform with gain applied (fades, ducking and normalization are visible in the wave) plus a yellow envelope line.
  - M/S buttons on every track that can carry sound.
  - Red bar plus label for missing or failed audio; "decoding…" while loading.
- **Layers list:** audio tracks show a speaker (mute) instead of the eye.
- **Audio panel:** role, mute, volume (◆ automation), gain (◆), fade in/out (s), curve, peak readout, Normalize to −1 dB / Remove, level readout, source status.
- **Keyframes panel:** works for audio clips (% and dB units).
- **Playback:** Play uses the audio clock; edits are heard immediately.
- **Export audio mix (WAV):** full timeline, 48 kHz 16-bit stereo, with an inline player, peak, a clipping warning and Download.
- **Demo:** the main video's soundtrack plays (role "original"); the PiP's copy of the same soundtrack is muted so the voice isn't doubled.

## 8. Persistence

- Project format **v8**: `clip.audio` is validated with `normalizeClipAudio`.
- Audio settings on a clip without sound are rejected.
- Animation paths are checked per kind (`audio.*` only on audible clips, picture paths only on visual ones).
- v1–v7 projects load with default audio.
- Media is never embedded; audio is relinked by re-adding the file (§6).

## 9. Performance

- Decoding is one-time per source. Peaks are computed after "ready", so playback doesn't wait for the waveform.
- Scheduling is O(clips).
- Export mixing runs about 2–3 ms per second of timeline with 6 sources (measured), on the main thread.

## 10. Out of scope / not built

- LUFS loudness normalization (peak only).
- Panning and per-track bus volume.
- Audio effects (EQ, compression).
- Audio crossfades via transitions.
- Streaming playback of files over 30 min.
- Muxing the audio mix into a video file (this playground exports picture frames and the audio mix separately).
