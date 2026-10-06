# Phase 8 — Keyframe Animation Engine: Test Report

Date: 2026-10-02. Environment: macOS, Node 22, Vitest 5, Chrome via chrome-devtools-mcp (real rendering), Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **781 / 781 passed** (76 files). All 756 pre-Phase-8 tests pass **unchanged**. |
| New keyframe suite (`src/lib/animation/animation.test.ts`) | **25 / 25 passed** |
| Type checking (`tsc --noEmit`) | **0 errors** |
| `astro check` | **0 errors, 0 warnings**. No diagnostics in Phase 8 files; the 15 pre-existing hints are elsewhere. |
| Linting | **No linter is configured in this repo**; `tsc` + `astro check` are the static checks. |
| Production build | **Success** |

**Mutation checks:**
- Flipping the trim-start shift and removing the split shift fails the trim/split test.
- Making auto-key overwrite the base value instead of keying fails the auto-key test.

## Required test areas

| Area | Automated | Live (browser, real rendering) |
|---|---|---|
| Position animation | Center at 0/30/60/100 = 200/950/1700/1700 (holds after last key) | X keyed 1700 → 300; field shows 1000 at frame 30 |
| Scale animation | Width doubles at the midpoint; scale keyed to 0 stays > 0 | Pentagon grows (filmstrip) |
| Rotation animation | 0 → 720 over 80 frames = 90° at 10, 450° at 50 (unwrapped) | Pentagon spins (filmstrip) |
| Opacity animation | 0 → 1: culled at 0, 0.5 at midpoint; value 5 clamps to 1 | Text fades in (filmstrip) |
| Crop animation | Left 0 → 0.5 = 0.25 at midpoint (50 px source crop); never crops everything away | Matted video crop-wipe (filmstrip) |
| Multiple properties | Position + rotation (ease-in-out) + opacity on one clip | Text: position + opacity; pentagon: rotation + scale X/Y |
| Multiple objects / layer kinds | Same keyframes on a shape **and** a text layer evaluate identically | Text, polygon, SVG, matted video animating together |
| Timeline scrubbing | 100 frames evaluated in random order == sequential (pure function of frame) | Scrubbing updates the inspector to the interpolated value |
| Playback | Monotonic ease-out move, reaches and holds the end | With the tab in the foreground: rAF 61/s, playhead advances at 30 fps, X matches interpolation exactly at every sample (f2 = 1645.3, f30 = 880) |
| Save / reload | Keyframes incl. Bézier, hold and crop round-trip; matrix/opacity/crop identical at 18 sampled frames; 6 kinds of invalid animation rejected | Save → full page reload → Load: frames 0/17/33/52/60 **pixel-identical** (5 animated clips) |
| Undo / redo | 8 keyframe ops (stopwatch, add, update easing, move, auto-key edit, remove…) each one step; undo/redo return identical snapshots | Stopwatch + auto-key = 2 undo steps |
| Static objects unchanged | `applyAnimation` returns the same object; a static clip resolves identically at every frame; `setClipVisualsAtFrame` on a static clip produces exactly what `setClipVisuals` did; all 756 earlier tests unchanged | Static Y unaffected by scrubbing |

Also covered:
- **Easing:** endpoints and shapes, the CSS `ease` Bézier at 0.5 ≈ 0.8024, monotonic ease-in-out, a registered custom easing type used by evaluation.
- **Editing semantics:** "add keyframe" defaults to the current value; removing the last keyframe or turning the stopwatch off keeps the value at the playhead.
- **Keyframe moves:** a move onto an occupied frame is rejected with no change.
- **Clip edits:** moving a clip moves its animation; trimming the start, splitting, and duplicating preserve it (duplicate also offsets animated position); locked tracks and unknown properties are rejected.

**Live UI checks:**
- ◆ states (static → key → animated) are correct.
- A canvas drag at frame 30 on an animated layer inserted an X keyframe at 30 (880) while the static Y changed its base (210) without becoming animated.
- Keyframes panel rows and timeline diamonds appear at the right frames.
- No console errors.

## Visual QA

`.tmp-test-assets/phase5/qa/06-keyframes-filmstrip.png` (git-ignored): final-renderer frames 0/15/30/45/60. Ease-out slide-in + fade of text, ease-in-out spin + scale of a polygon, ease-in rise of an SVG heart, and a linear crop wipe on the matted video. All read correctly, with no jumps or clipping.

## Findings during Phase 8

- **No new product bugs found in testing.** One environment effect was investigated rather than assumed: playback looked stepped (0 → 29) because the automation tab was in the background with `requestAnimationFrame` throttled to ~1 fps. In the foreground, rAF ran at 61/s and playback was smooth and exact. The playback clock is wall-clock based, so throttling skips frames rather than slowing time, which is the intended behavior.
- One deliberate behavior change: the Rotation field no longer wraps typed values into (−180°, 180°]. With animation a keyframed 450° must stay 450°. Static layers are unaffected visually, since 450° and 90° render identically.

## Known issues / limitations

- Only numeric properties are animatable (position, scale, rotation, opacity, crop). Color/string interpolation (text color, shape fill) needs a per-property interpolator; the slot is designed (§3) but not implemented.
- No graph/curve editor. Easing presets come from a menu; custom Bézier keyframes (loadable from files) show as "Custom Bézier" and can't be edited in the UI yet.
- Anchor point and flip aren't animatable. Editing the anchor on a layer with animated position keys the position change at the playhead only.
- Keyframes outside a clip's range (e.g. after trimming) are kept, because they still shape the curve inside the range, but aren't shown on the timeline bar.
- Spring easing isn't implemented; it's an `registerEasing` entry away.
