# Transitions Engine — Changelog

## Phase 10 (2026-10-03)

### Added
- **Transition model** (`src/lib/transitions/model.ts`):
  - Edit-point `Transition` (id, type, track, from/to clip, duration, alignment, params, direction, easing, enabled, metadata) in `timeline.transitions`.
  - `transitionWindow` (the single validity/placement check) and `maxTransitionDuration` (per-clip in/out budgets).
  - Progress and easing, plus validation/normalization.
- **Registry** (`src/lib/transitions/registry.ts`):
  - 8 types: Cut, Fade, Dissolve, Cross dissolve, Slide, Push, Wipe, Zoom.
  - Typed number/color params, directions, default lengths.
  - `registerTransition` for custom/mask types.
- **Renderer-agnostic `TransitionPainter`** (draw / fill / maskLinear / mixPixels), with two implementations:
  - Canvas 2D (`lib/composition/transition-painter.ts`).
  - Software (`lib/transitions/software-painter.ts`) for exact tests.
- **Ops / engine:**
  - `addTransition`, `updateTransition`, `removeTransition`: one undo step each, with typed errors (`transition-not-found`, `invalid-transition`).
  - `reconcileTransitions` runs after every engine edit.
- **UI:**
  - Timeline transition bars (select, edge-drag resize, Delete).
  - ＋ at bare cuts.
  - Split-at-playhead button (S).
  - `TransitionsPanel` (all fields, Preview playback, transition in/out for the selected clip).
- **Project format v7** with placement validation.
- Tests: `src/lib/transitions/transitions.test.ts` (35).
- Docs: `TRANSITIONS_ARCHITECTURE.md`, `TRANSITIONS_TEST_REPORT.md`, this changelog.

### Changed
- `resolve.ts`:
  - An active transition contributes both sides of the track, tagged `layer.transition`.
  - New `sourceFrameAt` (source handles, else hold the edge frame).
- `draw.ts`:
  - The isolated-layer body is extracted as `renderLayerIsolated`.
  - New generic `drawTransition` (sides → registry compositor → composite).
  - `DrawOptions.getScratch(slot)`.
- `preview-renderer.ts` / `final-renderer.ts`: per-slot scratch canvases.
- `operations.ts`: `splitClip` gives the original clip's end-edge transition to the right piece.
- `viewport.hitTest` / `marqueeHits`: ignore layers shown outside their own span.
- `TimelinePanel`: header widened to 164 px.

### Fixed (found during this phase)
- Timeline header overflow: the split button overlapped the ruler.
- Transition bar labels were unreadable over clip labels.
