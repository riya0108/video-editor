# Phase 10 — Transitions Engine: Test Report

Date: 2026-10-03.

Environment:
- macOS, Node 22, Vitest 5.
- Chrome via chrome-devtools-mcp (real rendering of the real demo video).
- Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **843 / 843 passed** (78 files). All 808 pre-Phase-10 tests pass unchanged. |
| New transitions suite (`src/lib/transitions/transitions.test.ts`) | **35 / 35 passed** |
| Type checking (`tsc --noEmit`) | **exit 0** |
| `astro check` | **0 errors, 0 warnings**; no hints in Phase 10 files |
| Lint | No linter is configured in this repo; `tsc` + `astro check` are the static checks |
| Production build | **Complete** |
| Browser console during all live tests | **0 errors / 0 warnings** |

**Mutation checks** (each was reverted afterwards):

| Mutation | Tests failed |
|---|---|
| Remove the handle/hold clamp | 1 |
| Drop the split remap | 1 |
| Cross dissolve: `over` instead of additive | 2 |
| Off-by-one in the duration budget | 3 |

## Automated (Node)

**Compositors** — exact pixels through `SoftwarePainter`:
- All 8 types in every direction: progress 0 = exactly the outgoing clip, progress 1 = exactly the incoming clip.
- **Cut:** switches at 0.5.
- **Cross dissolve:** `(0.5,0,0.5)` at p = 0.5; a transparent partner fades without a dip.
- **Fade:** half-black at 0.25, black at the cut, white dip coming back; the dip stays inside a PiP's shape; boundary fade = transparency.
- **Dissolve:**
  - About 50% of pixels at p = 0.5.
  - Deterministic per seed; a different seed gives a different pattern.
  - Monotonic: switched pixels stay switched.
  - Half-res preview pattern = full-res pattern.
- **Slide:** right/up, plus slide-out at a boundary.
- **Push:** the marked pixel left the frame by the right amount.
- **Wipe:** right/left/down halves exact; the soft edge is monotonic and fully opaque.
- **Zoom:** in and out (center = mix, corner = only the enlarged side).
- **Extensibility:** a custom registered mask transition renders through the real resolve path.

**Model / ops:**
- Default placement: centered, 1 s, window [45,75).
- Clip map and timeline duration unchanged.
- Alignment (center / end / start).
- **Different durations:** 1, 90, a 1000 request clamped to 120, and "end" alignment clamped to 60.
- Typed rejections: not adjacent, unknown type, no clips, missing clip, edge already used (both edges), locked track, audio track.
- **Timeline boundaries:** fade-in at frame 0 and fade-out ending at the last frame; frame 180 is empty; duration unchanged.
- **Multiple transitions on one clip:** in/out budgets (41 and 20 frames computed), no overlapping windows, at most one group per frame.
- **Edit/resize:** direction, duration, easing; type change keeps shared params and fixes direction; alignment re-fit; param clamp; invalid easing rejected.
- **Disabled and removed:** both render identically to no transition.
- **Reconcile:**
  - Moving apart drops it; deleting a clip drops it.
  - Trimming shortens it (41).
  - Split moves it to the right piece (61).
  - A no-op returns the same object.
- **Undo/redo:** add → edit → resize → (move drops it) = 4 steps; undo and redo return the identical snapshots; undoing the move restores the transition.

**Evaluation:**
- Frames 44 and 75 are untouched; frames 45–74 hold (from, to) in order.
- Progress is `1/31 … 30/31`, strictly increasing.
- **Easing:** linear 0.1 at the first frame; ease-in-out slower at the start and exactly 0.5 at the midpoint.
- **Handles:** A shows source frame 70 past its out point; B starts early from frame 0 and holds 0 rather than −5; C (no known handles) holds its first frame; B continues to 75. Inside a clip's span, nothing changes.
- **Image, graphic (shape) and text transitions.**
- **Scrubbing:** 180 frames evaluated in a scrambled order are identical to sequential evaluation.
- **Playback:** progress is monotonic through a 40-frame window.
- Hit-testing ignores the out-of-span side.

**Persistence (v7):**
- Round trip: every field, cubic-bezier easing, disabled + metadata, color normalized.
- Resolve is identical at 7 frames.
- Ids are reserved.
- Rejected: unknown type, non-adjacent, missing clip, too long, non-integer duration, bad easing, shared edge.
- A v6 file loads.

**Draw path (recording canvas):**
- Sides render to slots 1 and 2, the mix to slot 3, then one composite onto main.
- Cross-dissolve alphas are exact (16/31 over, 15/31 additive).
- A missing side is reported as skipped, so the final render fails loudly.
- An unknown type falls back to a cut.

## Live (Chrome, real video, final renderer)

**UI:**
1. Select the main video, set the playhead to 4 s, press **Split**.
2. The ＋ appears at the cut; click it → a cross dissolve is added and selected.
3. The panel shows "max 240 f", and the bar is drawn over [3:15, 4:15).

To tell the sides apart, the incoming piece was given a −100% saturation effect, so it renders grayscale. Then every type was rendered in the **final renderer**, sampling frames 104 / 112 / 120 / 128 / 135 (window [105,135)):

| Type | Result |
|---|---|
| Cut | color through 112, gray from 120 (the cut) |
| Fade | darker at 112, **(3,3,3) black at the cut**, gray coming back |
| Dissolve / Cross dissolve | mixed at 120 (cross dissolve partially desaturated) |
| Slide → right | at 120 the left of frame shows the gray clip entering; the center is still the color clip |
| Push ← left | at 112 the color clip has moved off-center; at 120 the gray clip enters from the right |
| Wipe → right | mixed at the center at 120; gray at 128 |
| Zoom in | changes through the window; fully gray at 135 |

Frame 104 (before the window) was identical for every type, and frame 135 (after it) was the incoming clip for every type.

**Preview:**
- Screenshot at the cut: a soft wipe, left part gray, right part color, with the PiP/logo/title layers correctly on top.
- The first attempt showed no wipe. This was Chrome throttling `requestAnimationFrame` in a background tab, not a code bug: the preview renderer was verified directly to draw both sides, and the canvas updated once the tab was brought to the front.

**Other UI checks:**
- **Resize by dragging** the end edge 10 frames: centered duration 60 → **80**, with the live bar following the drag.
- **Preview button:** plays from 65 to 175 for window [80,160), with lead-in/out, at about 30 fps, then stops.
- **Delete key:** the transition is removed and the ＋ returns. Undo and redo step exactly: 80 → deleted → 80.

**Multiple transitions + boundaries:** six at once.

| Transition | Where | Result |
|---|---|---|
| Fade-in | video at frame 0 (timeline start) | frame 0 ≈ backdrop |
| Fade-out | video ending at 239 (timeline end) | ≈ backdrop at 239 |
| Slide-out down | text title | sliding off at 235 |
| Push up | shape badge (split) | moved away at 60 |
| Zoom-in | transparent PNG logo at frame 0 | small and faint at 0, full at 40 |
| Wipe | main video | — |

**Save → full page reload → Load:**
- All 6 transitions restored.
- **12/12 sampled final frames pixel-identical** (checksums), including frames inside every window.

**Export compatibility:**
- `FinalRenderer.renderRange(76..92)` (the sequential export path) compared with random-order `renderFrame` of the same frames: **0 mismatches**.
- Transitions go through the same `resolveFrame` / `drawResolvedFrame` as the preview, at full composition resolution with exact source frames.

## Performance (measured, 1920×1080 demo, 7 layers at frame 120)

| Frame | Preview ½ | Preview full |
|---|---|---|
| No transition | 3.9 ms | 7.6 ms |
| Cross dissolve | 8.4 ms | 13.0 ms |
| Wipe | 9.2 ms | 21.5 ms |
| Zoom | 13.3 ms | 39.2 ms |
| Dissolve (per-pixel readback) | 15.8 ms | 31.4 ms |

- Final frame with a dissolve (exact seeks of two video sources): about 315 ms.
- Every type holds real-time playback at the default ½ preview resolution.

## Bugs found during Phase 10

1. **Timeline header overflow (fixed).** The new Split button pushed the header past its 132 px width, so the button overlapped the "0s" ruler label. The header is now 164 px.
2. **Unreadable transition bars (fixed).** Clip labels showed through the striped transition bars ("Wipe" over "Main video"). The bars now have an opaque backing.
3. Test-authoring mistakes (my own expectations: progress at a window's first frame, back-to-front layer order, a frame outside a 15-frame cut window) were corrected. No product code changed for these.

## Known issues / limitations

- **Missing handles hold a frozen edge frame.** That is visible as a brief freeze when a video clip has no media beyond its out point (standard NLE behavior).
- **Blend modes:** a transition between two clips with *different* blend modes composites the mix with normal blending.
- **Dissolve is CPU-bound** on the readback; it is the heaviest type at full resolution.
- **Hidden dependency on playback:** the playground's playback clock needs the tab visible (browser rAF throttling); this is not a renderer issue.
- **Not built:**
  - Image/luma-mask transitions (the extension path is documented).
  - Audio crossfades.
  - Cross-track transitions.
  - Custom Bézier editing in the panel (presets only; custom curves round-trip from files).
