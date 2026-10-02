# Composition & Preview Engine — Architecture

Builds on the timeline engine (`TIMELINE_ARCHITECTURE.md`). The timeline says *what plays when*; this layer says *where it appears on the canvas and how it's drawn* — once for interactive preview, once (separately) for final output.

```
src/lib/timeline/visual.ts          per-clip visual data (transform, crop, opacity, blend, fit, matte), text style, shapes
src/lib/composition/
  matrix.ts             2D affine math (canvas setTransform layout)
  text-layout.ts        pure word-wrap/measure (measurer injected) + canvas measurer
  resolve.ts            (timeline, frame) -> ResolvedFrame   — THE one place layout is decided
  viewport.ts           coordinate spaces, zoom/pan/fit, hit-testing
  render-profile.ts     PREVIEW vs FINAL knobs; FINAL_PROFILE is frozen
  frame-provider.ts     interface: where pixels come from (peek = preview, exact = final)
  draw.ts               Canvas 2D rasterizer shared by both renderers
  preview-renderer.ts   sync, reduced-res, never blocks on media
  final-renderer.ts     async, full-res, exact frames, strict
  present.ts            preview raster -> screen (zoom/pan, pasteboard, checkerboard, selection)
  media-frame-provider.ts  browser FrameProvider (<video> / ImageBitmap)
src/components/tool/video/composition/
  CompositionPreview.tsx           reusable preview canvas component
  CompositionPlaygroundPanel.tsx   internal playground at /tools/video/composition-preview
```

## 1. Coordinate system

| Space | Units | Origin | Used for |
|---|---|---|---|
| content | source px (media) / comp px (text, shapes) | layer top-left | crop rects, drawing |
| **composition** | output pixels | top-left, y down | everything the user authors (`ClipVisual`) |
| render | raster px = comp × renderScale | top-left | the canvas being drawn (preview ≤ 1, final = 1) |
| screen | CSS px (× DPR for backing store) | preview element | zoom/pan, pointer input |

Every stored value is in **composition pixels**, so it renders identically at any preview scale and at export. Rotation is clockwise degrees (y-down). The project's resolution and background live on the timeline as `timeline.composition` (`{ width, height, background }`, even dimensions enforced, `"transparent"` allowed), so changing it is undoable.

## 2. Layer ordering
`timeline.trackIds[0]` is frontmost (already the timeline convention); the resolver paints in reverse. Audio and hidden tracks are skipped. Tracks never overlap internally, so there's at most one layer per track per frame. Reordering = `engine.reorderTrack`.

## 3. Clip visual model (`timeline/visual.ts`)
`Clip.visual?: ClipVisual` — undefined means "default": centered and fitted `contain`. Defaults are *derived*, so a resolution change re-centers untouched clips; clips with an explicit visual keep their composition-pixel coordinates.

- **transform**: `x, y` (anchor position), `anchorX/Y` (0..1 of the box), `scaleX/Y` (> 0), `rotation`, `flipX/Y`. Non-finite or non-positive values are *rejected* (`invalid-visual`); opacity and crop are *clamped* because they come from gestures.
- **crop**: normalized insets; clips *in place* (Premiere-style); at least 1% always stays visible.
- **opacity**, **blendMode** (normal/multiply/screen/overlay/darken/lighten/add → canvas composite ops).
- **fit**: contain/cover/fill/none for sized media; text and shapes are always `none`.
- **matte**: `{ sourceId, invert }` — the alpha channel of another source (e.g. a background-removal result), frame-aligned with the clip.
- Text clips carry `textStyle`; graphic clips carry either a `source` or a vector `shape` (rect/ellipse, fill, stroke, corner radius).

Operations: `setClipVisual` (deep-merge patch), `updateAuthoredContent` (text/style/shape), `setCompositionSettings`, and `insertClip(..., visual?)`. All go through history. **Split and duplicate now copy `visual`** — before this change both built the new clip from a fresh literal and would have dropped it.

## 4. Scene resolution and the transform matrix
`resolveFrame` produces, per active layer: the source frame (`sourceInFrame + (frame − timelineStart)`), content size, matrix, crop rect, opacity, blend, matte, and axis-aligned bounds. The matrix maps content px → composition px:

```
M = T(x,y) · R(rotation) · S(scaleX·flipX, scaleY·flipY) · T(−anchorX·boxW, −anchorY·boxH) · S(boxW/contentW, boxH/contentH)
```
where `box = fitBox(content, composition, fit)`. Layers with opacity 0 or fully off-canvas are culled. A layer whose source size isn't known yet is omitted and listed in `missingSources`. A **matted layer is omitted until its matte is known** — drawing it unmatted would flash the removed background.

## 5. Clipping and alpha compositing
- Composition bounds clip implicitly (the raster is the composition).
- Media crop: draw only the crop sub-rect (`drawImage` 9-arg form), mapped through the delivered image's *real* size, so proxies and lower-resolution mattes line up exactly. Text/shape crop uses a clip path.
- Compositing: Canvas 2D premultiplied source-over. Source alpha, `globalAlpha` (opacity) and blend combine multiplicatively.
- Mattes: the layer is isolated on a scratch canvas (content, then matte via `destination-in`, or `destination-out` when inverted), and only then composited with opacity and blend. A matte can never cut into the layers beneath it, and opacity is applied after matting.
- Transparent background → `clearRect`, not fill; alpha survives into the output.

## 6. Preview vs final — separated, not degraded
Both renderers call the same `resolveFrame` + `drawResolvedFrame`, so **geometry can't diverge**. They differ only in `RenderProfile`:

| | Preview | Final |
|---|---|---|
| resolution | Auto / Full / 1/2 / 1/4 | always 1.0 (comp size) |
| resampling | low while playing, high when paused | high |
| frames | `peekFrame`: whatever is decoded now | `getExactFrame`: seek, await the presented frame, snapshot |
| missing pixels | layer skipped, frame still shows | `FinalRenderError` |
| fonts | measured as available; re-measured on `loadingdone` | `document.fonts.load` awaited, then re-measured |
| canvases / decoders | its own | its own (never shares a `<video>` with preview) |

`FINAL_PROFILE` is `Object.freeze`d and the only profile `FinalRenderer` uses, so no preview setting can reach an export. **Auto** preview picks the smallest power-of-two scale with ≥ 1 render px per physical screen px at the current zoom — a fitted 4K comp renders at 1/2 (retina) or 1/4, and zooming in switches to full.

## 7. Viewport: zoom, pan, fit, fullscreen
`screen = comp × zoom + pan`. This reuses the matte viewer's `refine/viewport.ts` math and adds `fitToScreen`, `centerAtZoom`, preset `stepZoom` (anchored at the cursor), and `constrainViewport` (always keeps ≥ 48 px of the composition on screen). Fit is *sticky*: it re-fits on container resize or fullscreen until the user zooms or pans manually. Fullscreen uses the Fullscreen API on the preview element. Pasteboard, checkerboard, and selection/hover outlines are drawn in screen space by `present.ts`, never into the raster. Above 3× magnification the presenter switches to nearest-neighbour for pixel inspection.

Interaction (`CompositionPreview.tsx`): click → exact hit test (inverse matrix into content space, crop-aware, topmost first); drag → live transient override, committed as **one** undo step on release; arrows nudge (shift = 10 px); drag empty / middle / space-drag pans; ctrl/⌘ + wheel or pinch zooms; plain wheel pans; F fit, 1 = 100%, +/− step.

## 8. Browser frame provider
Preview decoders are pooled per `(source, clip)` slot, so the same video on two tracks at different times works. They play in real time and are re-seeked only beyond 0.2 s drift; while paused they chase the exact frame. Off-screen slots are paused, and slots idle for 10 s are released (this covers deleted/undone clips). Mid-seek, the last decoded frame stays on screen instead of blinking out. Exact frames are requested at `(n + 0.5)/fps` (mid-interval, immune to boundary rounding), serialized per source, and snapshotted to a canvas.

## 9. Verification (done)
- Unit (Node): matrix algebra, transform order, fit modes, crop-in-place, culling, missing-source/matte rules, text layout, hit-testing rotated+cropped layers, viewport math, profile invariants (frozen final), draw-call order for mattes/blend/opacity/proxy crop via a recording context, visual ops + undo. Mutation-checked: reversing the paint order fails 3 tests.
- Live (chrome-devtools-mcp, real `<video>` decode): full-quality paused preview vs final render **bit-identical** at frames 45 and 200 (max channel diff 0); final deterministic across out-of-order renders; transparent output keeps alpha 0 / soft matte ramp / PNG alpha × opacity; 4K comp → preview 1920×1080, final 3840×2160; playback holds 30 fps timing at 60 fps render; drag/nudge/zoom/fit/fullscreen work; no console errors.

## 10. Transform system (non-destructive)

Every visual layer exposes X, Y, width, height, scale X/Y, rotation, anchor point, opacity, crop, flip H/V, and blend mode. All of them are numbers in `ClipVisual`; every change is an undoable `setClipVisual` edit.

**Width/height** = fitted box × scale (`layerSize`). Editing them solves for scale about the anchor (`setLayerSize`), optionally linked. The source is never resized.

**Pure tool math** lives in `transform-tools.ts`. It works in box space, `p = pos + R·S·(u − anchor·box)`, which is unit-tested to agree exactly with the renderer's `layerMatrix`:
- `resizeFromHandle`: the opposite handle (or the anchor with Alt) stays fixed on screen under any rotation, flip, or crop. Corners keep aspect by default (Shift frees); edges change one axis (Shift keeps aspect). Dragging past the fixed point clamps rather than flipping.
- `rotateFromPointer`: rotates about the anchor; Shift snaps to 15° steps; magnetic pull to 0/90/180/270.
- `moveAnchorTo` / `setAnchorNormalized`: anchor and position re-solve together, so the layer never moves (tested: matrix drift 0). The anchor snaps to the 9 box points.
- `cropFromHandle`: crop edges follow the pointer in box space; the layer itself never moves.

**Snapping** (`snap.ts`): infinite target lines from composition edges and center, visible guides, shown safe zones, and every other layer's visible bounds (edges and centers). A moving rect snaps any of its left/center/right (top/middle/bottom) per axis. Ties go to guide > canvas > safe > layer. Tolerance is 6 screen px converted to composition px (zoom-independent). Resize/crop handles snap as points when the layer is axis-aligned; guides snap while dragged. Hold ⌘/Ctrl to suspend; a toolbar toggle turns snapping off.

**Guides** are project state (`timeline.guides`) with undoable add/move/remove: drag out of a ruler, drag to move, drag back onto a ruler to delete. **Safe zones** (`safe-zones.ts`): broadcast action 93% / title 90%, and an approximate social-vertical UI zone. They are display and snap aids only. **Alignment** (`align.ts`): left/center/right/top/middle/bottom of the visible bounds to the canvas or a safe zone, as a single translation edit.

**Input surfaces**, each producing one undo step per gesture:
- *Mouse* (`CompositionPreview`): move, resize, rotate (knob or just outside a corner), anchor, crop mode (C), guides from rulers, Shift axis-lock. Live feedback goes through a transient override; commit happens on release.
- *Keyboard*: arrows move (Shift ×10); Alt+↑/↓ scale; `[`/`]` rotate (Shift 15°); H/V flip; Esc exits crop, then deselects. Held/repeated keys coalesce into one edit committed on key-up.
- *Numeric* (`TransformPanel`): type + Enter/blur, Esc reverts, ↑/↓ steps (Shift ×10), drag a label to scrub (live draft, one commit). Linked W/H and scale, 9-point anchor grid, alignment buttons. Unchanged values never create an undo entry.

**No unnecessary rasterization**: a gesture only changes numbers. Each frame redraws the original source through one matrix (one resample, from source), and text and shapes are re-rasterized as vectors at output scale. Overlays and handles are screen-space only. Verified live: scale to 2.5% → 300% → rotate → crop → flip → restore produced a byte-identical final frame.

## Not in this pass
- Keyframed/animated transforms (visuals are static per clip).
- Encoding the final frame stream to a file (`FinalRenderer.renderRange` yields frames for a WebCodecs/ffmpeg encoder; that wiring is the export pass).
- Preview audio, decoder pre-roll before an upcoming clip, mixed-frame-rate conforming (inherits the timeline's simplification).
- Multi-layer selection/transform (engine selection supports it; the canvas tools are single-layer), distribute/align-to-each-other, and per-axis skew.
- The existing single-track Video Editor isn't migrated onto this engine yet.
