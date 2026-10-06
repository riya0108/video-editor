# Phase 10 — Transitions Engine: Architecture

Status: implemented and verified (see `TRANSITIONS_TEST_REPORT.md`). Builds on the timeline (non-overlapping tracks, snapshot undo), composition (`resolveFrame` → `drawResolvedFrame`), keyframe easing (Phase 8) and effects (Phase 9) engines without redesigning them.

## 0. Inspection: constraints that shaped the design

- **Tracks never overlap.** Every placement op enforces it, and the save validator rejects overlaps. Many NLEs implement a transition by overlapping two clips; doing that here would mean redesigning the timeline. **Decision:** transitions live at *edit points*. Inside the window, the outgoing clip continues past its out point and the incoming clip starts before its in point. They use **source handles** when the source has frames there, and **hold the edge frame** otherwise (Premiere's model). Clip positions, track invariants and the timeline duration never change, and deleting a transition restores the plain cut exactly.
- **`resolveFrame` is the single evaluation point** shared by the preview and final renderers. Transitions are resolved there, so preview and export can't disagree.
- **The isolated-layer path** (`draw.ts`, added for mattes and extended for effects) already renders one layer alone with its matte and effects. Transitions reuse it per side.
- **Phase 8 easing registry** gives each transition an easing curve without new math.

## 1. Pipeline

```
timeline.transitions (edit-point data)
 → resolveFrame: per track, is a transition window active at this frame?
     no  → the track's active clip, unchanged path
     yes → BOTH sides resolved (from, to) at this frame, tagged with {type, eased progress, params, direction, role}
 → drawResolvedFrame: each side rendered alone (content → matte → effects → its opacity)
 → registry compositor mixes the two through a TransitionPainter
 → the mix is composited at the track's z-position (blend mode of the sides)
```

## 2. Model (`src/lib/transitions/model.ts`)

```ts
interface Transition {
  id: string;                    // transition_id
  type: string;                  // transition_type (registry key)
  trackId: string;
  fromClipId: string | null;     // null = transition IN at toClip's start
  toClipId: string | null;       // null = transition OUT at fromClip's end
  duration: number;              // frames >= 1
  alignment: "center" | "end" | "start";   // window relative to the cut (pairs only)
  params: Record<string, number | string>; // parameters (validated against the definition)
  direction?: TransitionDirection;         // where applicable (left/right/up/down, in/out)
  easing: EasingSpec;            // Phase 8 easing (default ease-in-out)
  enabled: boolean;              // disabled = plain cut
  metadata?: { label?: string };
}
TimelineModel.transitions?: Record<string, Transition>
```

**Window.**
- Centered: `[cut − ⌊d/2⌋, cut − ⌊d/2⌋ + d)`.
- "end": `[cut − d, cut)`.
- "start": `[cut, cut + d)`.
- Boundary in: `[start, start + d)`.
- Boundary out: `[end − d, end)`.

**Progress** is `(f − start + 1)/(d + 1)`, strictly inside (0,1), so neither edge frame duplicates the frame just outside. The easing is then applied.

**Room / limits (`maxTransitionDuration`).**
- Each clip edge hosts at most one transition.
- The part of a transition inside a clip, plus the part of that clip's other-edge transition, must fit in the clip.
- So windows on a track never overlap, and every frame has at most one transition group per track.

**`transitionWindow()`** is the one validity check, used by the ops, by reconcile, by resolve and by the loader. It requires that:
- the track is visual;
- the clips are on that track;
- a pair is adjacent (`from.end === to.start`);
- the duration is at least 1 after clamping.

## 3. Registry (`src/lib/transitions/registry.ts`)

`TransitionDefinition { type, label, description, params: ParamDef[] (number | color), directions?, defaultSeconds, render(painter, args) }`.

Compositors are written against **`TransitionPainter`**, a small renderer-agnostic drawing interface. They never call Canvas 2D directly:

| Painter op | Meaning |
|---|---|
| `draw(side, {alpha, offsetX/Y, scale, origin, op})` | draw the outgoing/incoming surface; `op` = over / add (exact weighted sum) / under |
| `fill(color, alpha, "over"\|"atop")` | solid color; `atop` keeps the layer's shape (a PiP dips to black, not the whole frame) |
| `maskLinear(axis, from, to)` | multiply the result by a linear ramp (wipes) |
| `mixPixels(fn)` | per-pixel access to both sides (dissolves, luma/mask transitions) |

Two implementations:
- `CanvasTransitionPainter` (`lib/composition/transition-painter.ts`) is used by the app.
- `SoftwarePainter` (`lib/transitions/software-painter.ts`, premultiplied Float32) gives exact-pixel tests in Node and a reference implementation.

A GPU painter would implement the same seven members.

| Type | Compositor |
|---|---|
| Cut | outgoing until progress 0.5, then incoming |
| Fade | **Between clips:** dip through a color (default black, `atop`). **At a boundary:** the clip fades to/from transparency (so what's below shows) |
| Dissolve | granular/dither dissolve. A pixel shows B once `hash(cell) < progress`, so the switch is monotonic and deterministic, on a lattice anchored in **composition px** (preview = export) |
| Cross dissolve | `A·(1−p) + B·p` via over + additive, which is exact including alpha (no mid-point dip) |
| Slide | B slides in over a stationary A (at a boundary out: the clip slides away). Direction left/right/up/down |
| Push | A and B move together. Direction left/right/up/down |
| Wipe | moving feathered edge (softness param, at least 1 render px antialiasing). B is masked, A is drawn `under`. Direction left/right/up/down |
| Zoom | cross-zoom in log space: A scales `1→z`, B `1/z→1` (direction "out" reverses), cross-faded. Amount param |

**Extensibility:**
- `registerTransition(def)` adds a type. The resolver, draw core, persistence (types validated against the registry) and UI (type menu, param fields, direction menu, all generated from the definition) need no change.
- A custom **mask transition** is a compositor using `mixPixels`. The test suite registers one, a left-to-right mask, and renders it through the real resolve/draw path.
- A future image-mask (luma wipe) transition needs a mask-source param and a provider hook; the painter interface is already sufficient for the mixing.

## 4. Rendering integration

- **`resolve.ts`:**
  - Groups transitions by track once per frame.
  - For a track with an active window, it resolves both clips with `layer.transition = { id, type, progress, params, direction, role, paired, seed, outsideClip }` and pushes them adjacent (from, then to).
  - Out-of-span source frames come from `sourceFrameAt` (handle frames or a held edge, never a frame the source lacks).
  - Only opacity culling applies, because an off-canvas layer may slide into view.
- **`draw.ts`:**
  - The old isolated-layer body is now `renderLayerIsolated()`, shared by the matte/effects path and both transition sides.
  - `drawTransition()` renders each side to scratch slots 1 and 2 (opacity baked in), clears slot 3, runs the registered compositor through a `CanvasTransitionPainter`, and composites slot 3 onto the frame.
  - An unknown type falls back to a cut.
  - A side without pixels counts as **skipped**: the preview draws the other side, and the final renderer throws `FinalRenderError` instead of exporting a wrong frame.
- **Renderers:** `getScratch(slot)` keeps one lazily-created canvas per slot, so transitions use three extra frame-sized canvases only once one is drawn.
- **Picking:** `hitTest` / `marqueeHits` ignore layers shown outside their own span (`outsideClip`), so a click picks the clip that is really there.

## 5. Editing operations (pure, undoable through `TimelineEngine`)

- `addTransition({fromClipId, toClipId, type, duration?, alignment?, params?, direction?, easing?, enabled?})`:
  - Rejects with typed errors: unknown type, not adjacent, different tracks, an edge already used, a locked track, an audio track.
  - The duration defaults to the type's length and is clamped to the room available.
- `updateTransition(id, patch)`:
  - Edits type, duration (resize, clamped), alignment, params, direction, easing, enabled and metadata.
  - Changing the type keeps shared params and normalizes the direction.
- `removeTransition(id)`.
- **`reconcileTransitions(timeline)`**, run by the engine after *every* edit:
  - Drops transitions whose clips are gone, moved apart, or moved to another track.
  - Shortens those whose clips got shorter.
  - Returns the same object when nothing changed.
  - Undo restores both, because history snapshots the whole timeline.
- `splitClip` hands the original clip's end-edge transition to the right piece.

## 6. UI

- **TimelinePanel:**
  - A striped bar over each transition window; click selects it, drag either edge resizes it (twice the rate for centered windows), Delete removes it.
  - A **＋** at every bare cut between adjacent clips adds a cross dissolve.
  - A **Split at playhead** button (S key), used to create edit points in the playground.
- **TransitionsPanel:**
  - Shows enabled, type, duration (frames / seconds / max), alignment, direction, params (number/color), easing, delete and **Preview**.
  - Preview plays the window once with a half-second lead-in and lead-out, then stops.
  - With a clip selected, it offers "Transition in / out".
- Selecting a transition parks the playhead on its cut.

## 7. Persistence

Project format **v7**:
- `timeline.transitions` is validated by shape: known type, integer duration ≥ 1, valid easing, params clamped, colors hex.
- **Placement** is also validated: the clips exist on the track and meet, each edge is used at most once, and the duration fits.
- A corrupt file is a `ProjectFormatError`.
- v1–v6 files load with no transitions.
- Transition ids are reserved on load.

## 8. Performance

- Frames without an active transition take the unchanged path.
- A transition frame costs two isolated layer draws, one mix, and one composite.
- Dissolve reads both sides back once (`getImageData`); everything else is GPU-composited Canvas 2D.
- Measured costs are in the test report.

## 9. Out of scope

- Audio crossfades.
- Image-mask/luma transitions with user-supplied masks (the extension path is documented in §3).
- Transitions across tracks.
- Ripple trims that create handles.
