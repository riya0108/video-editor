# Phase 8 — Keyframe Animation Engine: Architecture

Status: implemented and verified (see `KEYFRAME_ENGINE_TEST_REPORT.md`); the implementation follows this design without deviations. Builds on the timeline, composition, transform, text, and graphics engines without redesigning them.

## 0. Inspection: where animation plugs in

Every consumer of a layer's placement (preview renderer, final renderer, hit-testing, selection handles, inspector) gets it from **one** function: `effectiveVisual` in `composition/resolve.ts`. Every layer kind (video, image, overlay, text, shape, SVG) goes through it. So **one** evaluation step there animates every layer type, with no per-type animation code, and preview and final can't disagree, because they already share `resolveFrame`.

## 1. Pipeline

```
Property (registry: path, get/set on a Clip, clamp)
   → Keyframes (per clip, per property: frame, value, easing of the outgoing segment)
   → Interpolation (easing registry: t ∈ [0,1] → eased t)
   → Evaluated value (pure: evaluateTrack(track, localFrame))
   → Evaluated clip (applyAnimation(clip, localFrame) → a Clip with animated values substituted)
   → Renderer (unchanged: resolveFrame reads the evaluated clip)
```

## 2. Data model

```ts
Clip.animation?: { tracks: Record<PropertyPath, KeyframeTrack> }
KeyframeTrack = { keyframes: Keyframe[] }          // sorted by frame, unique frames, ≥ 1 keyframe
Keyframe      = { id, frame, value: number, easing: EasingSpec }
EasingSpec    = { type: "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold" }
              | { type: "cubic-bezier", x1, y1, x2, y2 }
```

- **`frame` is clip-relative** (0 = the clip's first frame), so moving a clip moves its animation with it. Trimming the start shifts keyframes so they stay at the same timeline moment, and therefore the same moment of the media. Split gives each half the keyframes on its side, plus boundary keyframes at the cut so both halves look exactly as before.
- **Easing belongs to the outgoing segment** (keyframe k → k+1), the After Effects / Premiere model.
- **Non-destructive:** keyframes are data on the clip. The static `visual` stays as the property's base value and is untouched. Removing the last keyframe of a property returns it to that base.
- **Absent `animation` = static:** `applyAnimation` returns the *same clip object*. Static layers take exactly the old code path (verified by tests).

## 3. Property registry (`animation/properties.ts`)

`PropertyPath` → `{ label, get(clip, comp), set(clip, value, comp), clamp }`. Registered now (the brief's list):

| Path | Property |
|---|---|
| `visual.transform.x`, `visual.transform.y` | position |
| `visual.transform.scaleX`, `visual.transform.scaleY` | scale (clamped > 0) |
| `visual.transform.rotation` | rotation (not wrapped, so 0 → 720 spins twice) |
| `visual.opacity` | opacity (clamped 0–1) |
| `visual.crop.top/right/bottom/left` | crop (normalized, ≥ 1% visible) |

**Extensibility:** a property is just a registry entry with get/set on the Clip, so text (`content.textStyle.fontSize`), shapes (`content.shape.cornerRadius`), effects, masks, captions, or audio gain (on audio clips) need only a new entry. The evaluator, persistence, UI list, undo, and renderer integration don't change. Non-numeric values (colors) would add a per-type `interpolate` to the entry; the slot is documented but not implemented.

## 4. Interpolation (`animation/easing.ts`)

An **easing registry** maps `type` → `(spec) => (t) => t'`.
- `linear`
- `ease-in` / `ease-out` / `ease-in-out`: the CSS standard cubic-Béziers, solved numerically (Newton with bisection fallback)
- `hold`: step
- `cubic-bezier`: arbitrary control points, so **Bézier is already supported**

Custom curves and spring register a new type the same way, and nothing else changes. Values interpolate as `a + (b − a) · ease(t)`. Before the first keyframe the value holds the first; after the last it holds the last.

## 5. Editing semantics (auto-key)

All existing editing paths (canvas drag/resize/rotate, keyboard nudges, numeric fields, alignment) go through one op, `setClipVisualsAtFrame(patches, frame)`. For each changed registered property:
- **animated** → upsert a keyframe at the playhead with the new value (the AE/Premiere convention once a property's stopwatch is on);
- **not animated** → change the static base value (exactly the old behavior).

Non-animatable fields (flip, blend, fit, anchor, matte) always change the base. Everything stays one undo step per gesture.

Keyframe ops (pure, undoable, Result-returning through `TimelineEngine`):
- `addKeyframe(clipId, path, frame, value?, easing?)`: value defaults to the current evaluated value.
- `removeKeyframe`, `moveKeyframe`: rejects a collision with another keyframe on the same track.
- `updateKeyframe` (value / easing).
- `setPropertyAnimated(clipId, path, on)`: the stopwatch. Off removes the track; on adds a first keyframe at the playhead.

## 6. UI

- **Inspector:** a ◆ button per animatable field (filled = keyframe at the playhead, outlined = animated, faded = static). Prev/next-keyframe navigation. Fields show the *evaluated* value at the playhead.
- **Keyframes panel:** the selected clip's keyframes per property, with frame (move), value (edit), easing, and delete.
- **Timeline:** keyframe diamonds on the selected clip's bar. Click to jump the playhead there; drag to move.
- Preview, scrubbing, and playback need no new code: every rendered frame evaluates the animation.

## 7. Persistence

Project format **v5**. `animation` is validated on load: known paths, finite values, integer frames, sorted/unique, valid easing. Anything wrong is a `ProjectFormatError`. Older files have no animation (static), so no migration is needed.

## 8. Out of scope

Effects, transitions, captions, audio automation, AI. Color/string interpolation, motion paths, and graph editor UI are future work on this same engine.
