# Phase 7 — Shapes & Graphics Engine: Architecture

Status: implemented and verified (see `GRAPHICS_ENGINE_TEST_REPORT.md`). One change from the original design: legacy v1 "absent fill/stroke = off" migration runs only in the deserializer (version-aware), because inside `normalizeShapeSpec` it was ambiguous with new partial specs. Builds on the timeline, composition, transform (Phase 5), and text (Phase 6) engines without redesigning them. No new layer kind and no second transform system.

## 0. What already existed (inspection)

| Piece | Where | Reused as |
|---|---|---|
| `graphic` clip kind holding `source` (image) **or** `shape` | `timeline/clip.ts` | The graphic layer. Shapes and SVG are both `graphic` clips. |
| `ShapeSpec { type: rect\|ellipse, width, height, fill?, stroke?, strokeWidth, cornerRadius }` | `timeline/visual.ts` | Extended in place (moved to `timeline/shape-style.ts`, re-exported). |
| Vector drawing `drawShape` | `composition/draw.ts` | Extended: line, arrow, polygon, shadow. |
| Placement (position/scale/rotation/anchor/opacity/crop/flip/blend) | `ClipVisual` + Phase 5 tools | Unchanged. |
| Text shadow mapped through the layer matrix | `draw.ts applyShadow` | Generalized to any `ShadowFields` (text and graphics share it). |
| Layout-aware resize (handles change size, not scale) | Phase 6 `text-transform.ts` pattern | Same pattern for graphics (`graphic-transform.ts`). |
| Undo, persistence, timeline panel, multi-select, duplicate, z-order | engine / serialize / `TimelinePanel` | Unchanged; graphics flow through them. |

## 1. Data model

```
Clip { content: { kind: "graphic", shape?: ShapeSpec, svg?: SvgSpec, source?: MediaSourceRef, durationFrames }, visual?: ClipVisual }
```
Exactly one of `shape` / `svg` / `source` (an image graphic, unchanged).

**ShapeSpec v2** (`timeline/shape-style.ts`). All lengths are in composition px.

| Field | Applies to |
|---|---|
| `type`: `rect` \| `ellipse` \| `polygon` \| `line` \| `arrow` | all |
| `width`, `height` | all (line/arrow: `height` is the hit/box thickness, derived ≥ stroke and arrowhead) |
| `fill` (on/off), `fillColor` | rect, ellipse, polygon |
| `stroke` (on/off), `strokeColor`, `strokeWidth` | all (line/arrow are drawn with the stroke) |
| `cornerRadius` | rect (rounded rectangle = rect with radius > 0) |
| `sides` (3–64) | polygon (regular; vertex at top) |
| `arrowHead`: `end` \| `start` \| `both`, `headSize` | arrow |
| `shadow`, `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` | all |

Circle = ellipse with equal width/height (a preset; aspect locked by the default corner-resize rule). "Rounded rectangle" = rect preset with a radius. Toggle + value fields keep settings when an effect is off (same convention as text).

**SvgSpec**: `{ markup, width, height, intrinsicWidth, intrinsicHeight, tint?, tintColor, shadow… }`. The markup is **embedded in the project** (sanitized, ≤ 1 MB): an SVG graphic is authored content like text, so it survives save/reload with no media relinking. `tint` recolors single-color icons.

`normalizeShapeSpec` / `normalizeSvgSpec` are the only entry points (defaults, clamps, legacy migration of v1 `fill?: string`/`stroke?: string`). Project format → **v4**.

## 2. Rendering

- Shapes: vector paths drawn under the layer matrix at the render scale, so they're crisp at any zoom/scale and identical in preview and final. Closed shapes inset their stroke by half its width so it stays inside the box (never clipped). Line/arrow strokes run along the box's center line; the arrowhead is a filled triangle the shaft stops at, so the head and shaft never overlap or double-shadow.
- Shadow: one pass casts it (fill if present, else stroke), mapped through the full matrix (rotates/scales with the graphic; proportional in a half-res preview).
- **SVG: rasterized at the exact on-screen/output pixel size**, never at the SVG's intrinsic size and then scaled (that would blur). `SvgRasterizer` (`composition/svg-raster.ts`) sets the root's `width`/`height` to the target pixel size, decodes via `<img>` (sandboxed: no scripts, no external fetches), and caches by (markup, size, tint).
  - Preview: `peek()` returns the nearest cached raster, schedules the exact size, and triggers a redraw when it's ready. Sizes are quantized to limit re-rasterization while zooming.
  - Final: `get()` awaits the exact size; a failure is a `FinalRenderError` (strict, like media).

## 3. Transform integration

Graphics use `ClipVisual` and the Phase 5 tools unchanged. The one graphic-specific rule, like text: **resize handles change the graphic's own `width`/`height`, not the transform scale**, so stroke width, corner radius, and arrowheads keep their authored size instead of being stretched. Implemented by mapping the generic `resizeFromHandle` ratio onto a content + position edit (`editClips`, one undo step) that pins the opposite edge. Line/arrow ignore vertical resizing (their thickness comes from the stroke). The numeric Scale fields still apply a true transform scale for anyone who wants it.

## 4. Editor integration

- **Add shape / graphic** menu: rectangle, rounded rectangle, circle, ellipse, line, arrow, polygon, plus built-in SVG graphics. `.svg` files from Add media / drag-drop become SVG graphics.
- New layers start at the playhead, on their own front track, selected, sized relative to the composition (`addGraphicLayer`, one undo step).
- Graphics inspector (`GraphicsPanel`): type-specific fields, fill/stroke/shadow, SVG tint. Live drafts while scrubbing, one commit per change.
- Timeline: graphic clips are labelled by shape type / "SVG" and support move/trim/delete/duplicate/reorder through the existing ops.

## 5. Security

SVG markup is sanitized on import: `<script>`, `<foreignObject>`, event-handler attributes, `javascript:` URLs, and external `href`s are stripped, with a size cap and root-element check. It's only ever rendered through `<img>` (where SVG can't execute script or load external resources), never inserted into the DOM.

## 6. Out of scope

Boolean ops, custom paths/pen tool, gradients, per-node editing, effects, animation.
