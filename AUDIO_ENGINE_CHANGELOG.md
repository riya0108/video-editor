# Audio Engine — Changelog

## Phase 11 (2026-10-03)

### Added
- **`src/lib/audio/model.ts`:**
  - `ClipAudio` (role, volume, gainDb, fades + curve, mute, normalization) on `clip.audio` for audio/video/overlay clips.
  - Defaults, validation and dB helpers.
  - Fade shapes (linear / equal-power / s-curve).
  - Normalization math and role guessing.
- **`src/lib/audio/engine-core.ts`** (pure, shared by playback and export):
  - `audioSegments` (sync, mute/solo, missing sources), `clipGainAt` / `sampleEnvelope`.
  - Offline mixer `mixTimeline` (resampling, clipping report).
  - Waveform peaks / columns, peak level, WAV encode/decode.
- **`src/lib/audio/playback.ts`:**
  - `scheduleTimeline` (any BaseAudioContext).
  - `AudioPlaybackEngine`: audio clock as the master clock, continuous re-scheduling on edits, `clockRunning` fallback.
- **`src/lib/audio/source-store.ts`:**
  - Decode once, peaks, and per-source status (loading / ready+warning / no-audio / error / missing).
  - Metadata-first safety checks and timeouts.
- **`src/lib/audio/safety.ts`:** file allowlist and size cap, duration cap (30 min), memory budget, decoder-error classification, truncated-decode and truncated-WAV detection.
- **Keyframe properties** `audio.volume` and `audio.gainDb` (volume and gain automation).
- **Ops / engine:**
  - `setClipAudio` (auto-key when animated).
  - `normalizeClipAudioOp` / `engine.normalizeClipAudio`.
- **UI:**
  - `AudioPanel`.
  - `AudioWaveform` (wave × envelope + envelope line).
  - Timeline M/S buttons, 44 px audio rows, missing/error/decoding states.
  - Audio import into tracks named by role.
  - Relink by file name.
  - Audio-clock playback.
  - "Export audio mix (WAV)".
  - Layers list mute toggle for audio tracks.
  - Demo video soundtrack (PiP copy muted).
- **Project format v8** (`clip.audio`, kind-aware animation paths).
- Tests: `src/lib/audio/audio-engine.test.ts` (25).
- Docs: `AUDIO_ENGINE_ARCHITECTURE.md`, `AUDIO_ENGINE_TEST_REPORT.md`, this changelog.

### Changed
- `media-import.ts`: audio files are accepted (validated) instead of rejected; the test was updated to the new contract.
- `operations.ts`:
  - `requireAnimatableClip` is kind-aware (audio.* on audible clips).
  - `splitClip` gives the fade-in to the left piece and the fade-out to the right.
- `KeyframesPanel`: % / dB units for audio paths; wider value field; generic hint text.
- `TimelinePanel`: scroll area raised to 24 rem.

### Fixed (found during this phase)
- A truncated WAV loaded silently as a short clip; it now loads with a visible warning.
- "Re-add to relink" didn't relink; audio now relinks in place.
- Re-scheduling during playback held the playhead about 80 ms; it is now continuous.
- An autoplay-blocked audio context could freeze the picture; it now falls back to the wall clock.
- The Keyframes value field was too narrow ("60%" showed as "6%").
