# Core Non-Destructive Timeline Engine — Architecture

Status: core engine only. No UI, no transitions/effects, no rendering/export integration — those are explicitly out of scope for this pass. This document is written before implementation, per the brief; implementation follows exactly this design.

## Scope

In scope: `timeline model`, `clip model`, `track model`, `time model`, `selection model`, `edit operations` (trim, split, move, duplicate, delete, insert, track lock/visibility/mute/solo, reorder), `undo/redo integration`, frame-accurate positioning, snapping math.

Out of scope (deliberately): any React component, any rendering/compositing, transitions, effects, speed ramping, audio mixing/waveform analysis, export/encode integration, media asset management (file upload/storage — the engine only ever holds an opaque reference to a source, never a `File`/`Blob`/URL).

## Where this lives

New, framework-agnostic directory: `src/lib/timeline/`. Zero dependency on React, the DOM, or `src/lib/ffmpeg/**` — pure TypeScript, fully unit-testable in Node. This is a parallel, new foundation; it does not replace or modify the existing single-track `src/lib/hooks/useClipTimeline.ts` / `src/lib/ffmpeg/build-editor-command.ts` editor, which a later integration pass can migrate onto this engine. `src/lib/time.ts` (seconds-based display formatting, `clamp`) is unrelated and untouched — reused where convenient, not duplicated.

```
src/lib/timeline/
  errors.ts          TimelineEditError + reason codes
  id.ts              deterministic id generation
  time-model.ts       frame <-> seconds conversion, timecode format/parse, frame-rate type
  clip.ts            Clip types, constructors, per-clip derived helpers
  track.ts           Track type, constructor, derived audibility
  model.ts           TimelineModel aggregate: tracks + clips + lookups
  selection.ts       Selection value + pure operations (not undo-tracked)
  snapping.ts        snap-point collection + nearest-snap math
  operations.ts       all edit operations (pure, immutable, throwing)
  history.ts         generic undo/redo stack
  engine.ts          TimelineEngine: ties model+history+selection+operations into one API
  index.ts           public barrel export
```

## Core design decisions

### 1. Everything is immutable; edits are pure functions

`TimelineModel`, `Track`, and `Clip` are plain, deeply-immutable-by-convention data (never mutated in place). Every edit operation has the shape `(timeline: TimelineModel, params) => TimelineModel` — it returns a **new** `TimelineModel` with new `tracks`/`clips` maps; everything not touched is structurally shared (same object references) for cheap equality checks and cheap snapshotting.

This is what makes undo/redo trivial and provably correct: instead of writing a separate, error-prone "inverse" for every operation (a classic source of undo bugs — e.g. an inverse that doesn't perfectly restore clip order), undo/redo is pure history snapshotting (§7). It's also what makes "non-destructive" structural, not just a convention: there is no mutation path to the original source media because the engine never holds source bytes at all (§2).

### 2. Non-destructive by construction, not by discipline

A clip never embeds or copies source media. It holds a `MediaSourceRef`:

```ts
interface MediaSourceRef {
  sourceId: string;   // opaque id, resolved to an actual File/URL by a layer outside this engine
  label?: string;      // display-only
}
```

Trimming, splitting, moving, duplicating, and deleting all operate exclusively on **pointers into the source** (`sourceInFrame`/`sourceOutFrame`) and **position on the timeline** (`timelineStart`). The engine has no file I/O, no canvas, no ffmpeg, no fetch — "cannot modify the original media" is enforced by the module having no capability to touch media bytes in the first place, not by a rule someone could accidentally violate.

### 3. Time model: integer project frames, not floating-point seconds

All positions (`timelineStart`, `sourceInFrame`, `sourceOutFrame`, durations) are **integers, in project frames** at the timeline's own `frameRate`. This is what "frame-accurate positioning" means concretely: no floating-point drift from repeated seconds-based arithmetic, and "snap to the nearest frame" is just integer rounding.

`time-model.ts` provides the only sanctioned boundary between frames and seconds:

```ts
secondsToFrames(seconds: number, fps: number, round: "nearest" | "floor" | "ceil" = "nearest"): number
framesToSeconds(frames: number, fps: number): number
formatTimecode(frames: number, fps: number): string   // HH:MM:SS:FF
parseTimecode(tc: string, fps: number): number         // -> frames
```

Edit operations (`operations.ts`) take and return **frames only** — never seconds — so the core engine can never be the source of a rounding bug; any seconds-based UI converts at its own boundary, explicitly, once.

**Documented simplification**: this version assumes every source's native frame rate matches the project's. Conforming mixed-frame-rate source media (e.g. 24fps footage dropped onto a 30fps timeline) is a real, separate feature (frame-rate retiming) and is explicitly deferred, not silently mishandled — `MediaSourceRef` has room to grow a `sourceFrameRate` field later without breaking this API.

### 4. Clip model

```ts
type ClipKind = "video" | "image" | "audio" | "text" | "graphic" | "overlay";

interface ClipBase {
  id: string;
  trackId: string;
  timelineStart: number; // frames, >= 0
}

type Clip = ClipBase & { content: ClipContent };

type ClipContent =
  | { kind: "video";   source: MediaSourceRef; sourceInFrame: number; sourceOutFrame: number }
  | { kind: "audio";   source: MediaSourceRef; sourceInFrame: number; sourceOutFrame: number }
  | { kind: "overlay"; source: MediaSourceRef; sourceInFrame: number; sourceOutFrame: number } // PIP-style: a video/image composited above other layers
  | { kind: "image";   source: MediaSourceRef; durationFrames: number }
  | { kind: "graphic"; source: MediaSourceRef; durationFrames: number } // logos/shapes/stickers
  | { kind: "text";    text: string; durationFrames: number };
```

Two clip families, one invariant rule each — **duration is always a single source of truth, never two fields that can drift apart**:

- **Trim-capable** (`video`, `audio`, `overlay`): duration is *derived*, `sourceOutFrame - sourceInFrame`. There is no separate stored duration to go stale.
- **Timeline-authored** (`image`, `graphic`, `text`): no source trim concept (a still image or a text block has no inherent in/out) — `durationFrames` is stored directly and is itself what "trimming" adjusts.

`clip.ts` exposes `clipDurationFrames(clip)` and `clipTimelineEnd(clip)` so every other module reads duration through one function regardless of kind — nothing else is allowed to branch on `content.kind` to compute a duration by hand.

### 5. Track model

```ts
type TrackKind = ClipKind; // a track's kind constrains which clip kind it accepts

interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clipIds: string[]; // maintained in ascending timelineStart order by operations.ts, never by callers
  locked: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
}
```

A track holds only same-kind clips (`track.kind === clip.content.kind`, checked at insert time) — this is what makes "multiple video tracks / multiple image tracks / text tracks / graphics / audio tracks / overlays" a structural property (six independent track kinds, any number of tracks per kind) rather than a convention someone could violate by dropping a text clip onto a video track.

**A track is a non-overlapping sequence.** Two clips on the same track may never overlap in time — that's the entire reason multi-track exists (overlapping content goes on a second track). Every placement-affecting operation (insert/move/trim/split/duplicate) validates this and rejects (throws) a placement that would overlap. This is the single most load-bearing invariant in the whole model and is enforced in exactly one place (`model.ts`'s `findOverlap`), not re-implemented per operation.

**Solo is derived, not stored-and-mutated.** Muting every *other* track when one is solo'd would mean un-soloing has to remember and restore prior mute states — a classic stateful-bug source. Instead, `track.ts` exposes a pure function:

```ts
isTrackAudible(timeline: TimelineModel, trackId: string): boolean
// = track.solo ? true : (anyTrackInTimelineIsSoloed ? false : !track.muted)
```

Nothing ever writes to another track's `muted` field as a side effect of toggling `solo`.

### 6. Selection model — deliberately outside undo/redo

```ts
interface Selection {
  selectedClipIds: ReadonlySet<string>;
}
```

Pure operations: `select`, `toggleSelect`, `selectMany` (multi-selection), `selectRange` (all clips on a track whose span falls within a frame range — the natural "shift-click" / rubber-band semantics), `clearSelection`, `isSelected`.

**Selection changes are never pushed onto the undo stack.** Undo/redo is for structural edits a user would want to reverse (a bad trim, an accidental delete); losing your multi-selection because you hit Ctrl+Z is a correctness bug in most real editors, not a feature. This is why `Selection` is modeled as a value *separate* from `TimelineModel` and lives in `TimelineEngine` alongside — not inside — the undo history (§7).

### 7. Undo/redo: snapshot history, not inverse commands

```ts
interface History<T> {
  past: T[];
  present: T;
  future: T[];
}
createHistory<T>(initial: T): History<T>
pushHistory<T>(h: History<T>, next: T, maxDepth?: number): History<T> // drops future (new edit invalidates redo), caps past at maxDepth
undo<T>(h: History<T>): History<T>
redo<T>(h: History<T>): History<T>
```

Generic, reusable, and — critically — **correct by construction**: because every edit operation already returns a brand-new, fully-independent `TimelineModel` (§1), "undo" is just "go back to the previous one," with no risk of an inverse function reconstructing state slightly wrong. The cost is memory (each history entry is a full `TimelineModel`, though structural sharing from §1 means unchanged tracks/clips are shared references, not deep copies) — `maxDepth` bounds it. If profiling ever shows this is a real problem for very long sessions, the documented escalation path is switching to command-objects-with-inverses; not needed for this core pass.

### 8. The engine: ties it together, converts throws into results

`operations.ts` functions throw a typed `TimelineEditError` (`{ reason: "track-locked" | "track-not-found" | "clip-not-found" | "kind-mismatch" | "overlap" | "out-of-range" | "invalid-split-point" }`) on invalid usage — cheap to compose and test at that layer.

`TimelineEngine` (`engine.ts`) is the one public surface meant for real callers. Every mutating method:
1. Checks the target track isn't locked (operations.ts also checks this — defense in depth, see tests).
2. Calls the pure operation.
3. On success: pushes the previous timeline onto history, returns `{ ok: true, timeline }`.
4. On a `TimelineEditError`: does **not** touch history, returns `{ ok: false, error }`.

This means a UI calling `engine.deleteClip(id)` on a locked track gets a normal, typed failure result to show the user — not an uncaught exception, and no corrupted/partial history entry.

```ts
class TimelineEngine {
  // state
  get timeline(): TimelineModel
  get selection(): Selection
  get canUndo(): boolean
  get canRedo(): boolean

  // history
  undo(): void
  redo(): void

  // selection (not undo-tracked)
  select(clipId: string, additive?: boolean): void
  selectMany(clipIds: string[]): void
  selectRange(trackId: string, startFrame: number, endFrame: number): void
  clearSelection(): void

  // structural edits (undo-tracked, Result-returning)
  addTrack(kind: TrackKind, name?: string): EditResult
  removeTrack(trackId: string): EditResult
  reorderTrack(trackId: string, newIndex: number): EditResult
  setTrackLocked(trackId: string, locked: boolean): EditResult
  setTrackVisible(trackId: string, visible: boolean): EditResult
  setTrackMuted(trackId: string, muted: boolean): EditResult
  setTrackSolo(trackId: string, solo: boolean): EditResult
  insertClip(trackId: string, content: ClipContent, timelineStart: number): EditResult
  trimClip(clipId: string, edge: "start" | "end", newFrame: number): EditResult
  splitClip(clipId: string, atFrame: number): EditResult
  moveClip(clipId: string, newTimelineStart: number, newTrackId?: string): EditResult
  duplicateClip(clipId: string, newTimelineStart?: number): EditResult
  deleteClip(clipId: string): EditResult
  deleteClips(clipIds: string[]): EditResult  // multi-selection delete, one history entry
}
```

### 9. Trim and split semantics (precise, since these are the two trickiest edits)

**Trim** (`trimClip(clipId, edge, newFrame)`):
- `edge: "end"` — shortens/lengthens from the right. `timelineStart` and `sourceInFrame` are unchanged; `sourceOutFrame` (trim-capable) or `durationFrames` (timeline-authored) changes to match `newFrame`.
- `edge: "start"` — shortens/lengthens from the left. `timelineStart` moves to `newFrame`; for trim-capable kinds `sourceInFrame` shifts by the same delta (so the content visible at the new start is whatever was already playing at that offset into the source — the standard trim-handle behavior, not a reposition); for timeline-authored kinds only `timelineStart`/`durationFrames` change (there's no source to shift).
- Clamped: can never trim past the source's available range (`sourceInFrame >= 0`, `sourceOutFrame <= ` the source's known duration if provided) or below a 1-frame minimum duration. Clamping, not silent failure — if the requested `newFrame` is out of range it's clamped to the nearest valid frame, since that matches how a drag-to-trim UI interaction actually behaves (the handle stops at the limit, it doesn't reject the gesture).
- Rejects (throws) if the trimmed result would overlap the clip's own neighbor on the same track.

**Split** (`splitClip(clipId, atFrame)`):
- Produces two clips from one. The **left piece keeps the original clip's id**; the **right piece gets a new id** — both now independent, both still only reference-pointing into the same original `MediaSourceRef`, nothing is copied or re-encoded.
- Left: `timelineStart` unchanged, trimmed at `atFrame` the same way `trimClip(..., "end", atFrame)` would.
- Right: `timelineStart = atFrame`, `sourceInFrame` advanced by exactly the same number of frames the left piece lost from its end (trim-capable kinds) — guaranteeing the two pieces are frame-exact and gapless, reconstructible back into the original by undo.
- Rejects `atFrame` outside `(timelineStart, timelineEnd)` exclusive — a split exactly on an edge isn't a split.

### 10. Snapping

Pure, stateless, and deliberately has zero opinion about pixels/UI — it operates purely in frame space:

```ts
collectSnapPoints(timeline: TimelineModel, opts?: { excludeClipIds?: string[]; extra?: number[] }): number[]
// every clip's timelineStart and timelineEnd across every track, frame 0, plus any extra
// caller-supplied points (typically the playhead) — deduplicated, sorted.

snapToNearest(target: number, points: number[], thresholdFrames: number): number
// returns the nearest point within thresholdFrames, else target unchanged.
```

A caller (future UI) computes `collectSnapPoints` excluding the clip currently being dragged, then runs the live drag position through `snapToNearest` each frame of the gesture, then calls `engine.moveClip`/`trimClip` with the (possibly snapped) result. The engine's own edit operations never snap implicitly — snapping is an input-shaping concern the caller opts into, not a hidden behavior inside a structural edit.

## What's explicitly NOT here (by design, per the brief)

- No transitions/effects (crossfades, filters, speed ramps).
- No rendering, compositing, playback, or export/encode wiring.
- No React components, hooks, or any visual timeline UI.
- No media asset management — `MediaSourceRef.sourceId` is opaque; resolving it to real bytes is a different layer's job.
- No ripple-delete / ripple-trim (every delete/trim only ever affects the targeted clip(s); gaps are left behind, not auto-closed) — a deliberate, documented scope cut, not an oversight; ripple editing changes multiple clips' positions as a side effect and is a reasonable follow-up once the core model is settled.
- No mixed-frame-rate conforming (§3).

## Testing strategy

Every module gets its own `*.test.ts` under `src/lib/timeline/`, following this repo's existing convention (see `src/lib/matting/pipeline/**`). Coverage required before this is considered done:
- `time-model`: frame/second round-tripping at multiple fps including non-integer fps (29.97), timecode format/parse round-trip.
- `clip`/`track`/`model`: constructors, derived-duration correctness for every clip kind, overlap detection (including exact-edge-touching = not an overlap).
- `operations`: every operation's happy path, every documented rejection (locked track, overlap, kind mismatch, out-of-range, bad split point), and the trim/split frame-exactness guarantee in §9.
- `selection`: single/multi/range selection, and that selection survives an unrelated structural edit but not necessarily a delete of the selected clip itself (deleting a selected clip also removes it from selection — documented in `selection.ts`).
- `history`: push/undo/redo, redo cleared by a new push after an undo, maxDepth capping.
- `engine`: the full integration — a mutating call that fails (locked track) does not grow history; multi-select delete is one undo step, not N; undo after a split restores the single original clip (not two half-sized leftovers); solo/mute derive correctly across multiple soloed/unsoloed tracks.
