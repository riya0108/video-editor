# Shapes & Graphics Engine — Changelog

## Phase 7 (2026-10-02)

### Added
- **Graphics model** (`src/lib/timeline/shape-style.ts`):
  - `ShapeSpec` v2: rect (+ rounded), ellipse (+ circle preset), regular polygon, line, arrow; fill/stroke toggles + colors; corner radius; sides; arrowheads and head size; shadow.
  - `SvgSpec` for embedded SVG graphics, with tint and shadow.
  - `normalizeShapeSpec` / `normalizeSvgSpec` / `patch*` (the only entry points), `shapePreset`, and `ShadowFields`, which are shared with text.
- **SVG import** (`src/lib/graphics/svg.ts`): sanitizer (scripts, handlers, external refs, entities stripped; 1 MB cap), intrinsic size parsing, rasterize-at-size markup, raster size quantization.
- **SVG rasterizer** (`src/lib/composition/svg-raster.ts`): rasterizes at the exact draw size, so SVGs stay vector-sharp. Preview peeks without blocking and redraws when the raster is ready; final awaits. Bounded LRU cache; decoding via `<img>`.
- **Graphic-aware resize** (`src/lib/graphics/graphic-transform.ts`): handles change the graphic's own width/height (stroke, radius and arrowheads keep their authored size; SVG re-rasterizes). Reuses the Phase 5 handle math; one undo step.
- **Built-in graphics** (`src/lib/graphics/library.ts`): heart, star, check badge, speech bubble, location pin, play button (original simple icons).
- **Ops / engine:** `addGraphicLayer` (one undo step, selects the layer); `updateAuthoredContent` accepts `shape` (normalized) and `svg` patches.
- **UI:**
  - "Add shape…" menu (7 shapes + built-in graphics).
  - `GraphicsPanel` inspector (size, radius, sides, arrowheads, fill, stroke, tint, shadow).
  - `.svg` files become vector graphics via Add media or drag-and-drop.
  - Timeline labels/icons for graphics.
- **Project format v4:** v3 shapes migrate (color-string fill/stroke → toggle + color); embedded SVG validated on load.
- Docs: `GRAPHICS_ENGINE_ARCHITECTURE.md`, `GRAPHICS_ENGINE_TEST_REPORT.md`, this changelog.
- Tests: `src/lib/graphics/graphics-engine.test.ts` (28).

### Changed
- `ShapeSpec` moved from `timeline/visual.ts` to `timeline/shape-style.ts` (still re-exported); `fill`/`stroke` are now booleans plus `fillColor`/`strokeColor`.
- `draw.ts`:
  - `drawShape` handles all shape types with single-pass shadows.
  - SVG layers draw from their raster.
  - `applyShadow` takes `ShadowFields`, shared by text and graphics.
- `resolve.ts`: new `svg` layer content; shapes normalized (cached per content object).
- Preview/Final renderers fetch SVG rasters at the exact device-pixel size; final failures are `FinalRenderError`.
- `CompositionPreview`: graphic-aware resize; redraws when an SVG raster becomes ready.
- `media-import.ts`: `.svg` is routed to the vector path instead of being decoded as a bitmap.
- `TextPanel`: exports `ColorField`, `Toggle` and `Seg` for reuse (no behavior change).

### Fixed
- An ambiguous legacy-shape migration that turned off fill and stroke on valid new-style partial specs. The version-aware rule now lives in the deserializer.

### Not included (per scope)
Custom paths/pen tool, boolean ops, gradients, animation, effects.
