# Phase 7 — Shapes & Graphics Engine: Test Report

Date: 2026-10-02. Environment: macOS, Node 22, Vitest 5, Chrome via chrome-devtools-mcp (real rendering), Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **756 / 756 passed** (75 files). All pre-Phase-7 tests still pass. |
| New graphics suite (`src/lib/graphics/graphics-engine.test.ts`) | **28 / 28 passed** |
| Type checking (`tsc --noEmit`) | **0 errors** |
| `astro check` | **0 errors, 0 warnings**. The 15 pre-existing hints are all in matting/media/upscale files; none in Phase 7 files. |
| Linting | **No linter is configured in this repo** (no ESLint/Biome config or script); `tsc` + `astro check` are the static checks. |
| Production build | **Success** |

**Mutation checks** (proving key tests can fail):
- Removing the position re-pin after a resize fails the resize test.
- Letting the stroke cast a second shadow fails the shadow test.
- No longer stripping `<script>` fails the SVG-safety test.

## Required test areas

| Area | Automated (graphics-engine.test.ts) | Live (browser) |
|---|---|---|
| Create | All 7 presets + SVG: own front track, at playhead, selected, 1 undo removes it | All 10 menu items created via the real "Add shape" select → 10 undo steps, timeline bars, inspector shown |
| Edit | Patches normalized and clamped (sides 99→64, radius −5→0); content immutable; SVG patch on a shape is a typed error | Inspector fields |
| Resize | Handle resize changes the shape's own size; stroke/radius unchanged; opposite corner pinned; one undo; Shift frees aspect; lines ignore vertical; SVG box resizes and the raster follows | Real canvas drag: 432→648 px, stroke 12, radius 30, scale 1, corner drift 0, 1 undo step |
| Rotate / Move | Shared transform: rotation about anchor, bounds swap | (Phase 5 live tests) |
| Duplicate / Delete / Reorder | Independent copy with new id; paint order follows reorder; delete undoable | — |
| Opacity | `globalAlpha` on the fill | — |
| Fill / Stroke | Fill color; stroke inset inside the box (`roundRect(5,5,390,190,30)` for a 10 px stroke); toggles keep colors | — |
| Shadow | One pass only (fill), mapped through rotation and render scale (offset (0,5), blur 10 at 0.5× after 90°) | Visible in QA render |
| Polygon / Arrow | 5-gon: 5 vertices, first at top; arrow shaft stops at head base (0→460), head filled in stroke color | Visible in QA render |
| Timeline duration | Visible only in [start, end); trim extends | — |
| Save / reload | All 7 types + tinted SVG round-trip exactly with identical matrices/content; v3 shapes migrate; invalid embedded SVG rejected | Save → full page reload → Load with **21 graphics: pixel-identical** final render (hash `62b55932`) |
| Undo / redo | 7 operations each one step; undo/redo return identical snapshots | — |
| Multiple graphics | 6-layer stack | 10+ in one scene |
| Over video / transparent media / text | Paint order video → circle → matted cutout → SVG → text → arrow | QA render (below) |
| SVG safety | Scripts, event handlers, `javascript:`, external refs, CSS `url()`, entity declarations stripped; internal `#refs` kept; non-SVG and >1 MB rejected | Uploaded `badge.svg` containing `<script>` + `onload`: both stripped, artwork kept |
| SVG sizing | Intrinsic size from width/height → viewBox → default; raster at exact target size; preview quantized up (never below need), capped | 100×100 icon shown at 520 px: vector-sharp |
| Error handling | Garbage shape values render with defaults; a line can't be made invisible; new-style partial specs aren't mistaken for legacy | No console errors |

## Visual QA (final-renderer output)

`.tmp-test-assets/phase5/qa/05-graphics-scene.png` (git-ignored). Checked items:

| Item | Result |
|---|---|
| Rounded rectangle with stroke + shadow over video | ✅ |
| Rotated arrow over video (head and shaft meet cleanly) | ✅ |
| Stroke-only circle around the matted subject | ✅ composites above the transparent subject |
| Rotated SVG star over the subject | ✅ |
| Hexagon + line over text | ✅ correct z-order |
| SVG enlarged 5.2× | ✅ sharp edges, no bitmap blur |

## Bugs found during Phase 7

1. **Ambiguous legacy migration (real bug, fixed).** The first version guessed whether a shape was a v1 shape, which stored fill/stroke as optional color strings with *absent* meaning "off". Valid new-style partial specs such as `{ stroke: true, strokeWidth: 6 }` were misread as v1 and came out with fill and stroke both **off**. Fixed: only unambiguous legacy values (color strings) migrate in `normalizeShapeSpec`; the "absent = off" rule is applied only by the deserializer, for files saved before v4. A regression test covers both.
2. One test-fixture mistake: it assumed SVG import scales small icons *up*, but it only scales down. The test was fixed to assert against the real starting width.

## Known issues / limitations

- Polygons are regular (equal sides); no custom point editing, pen tool, booleans, or gradients.
- Corner radius applies to rectangles only.
- SVG tint recolors every painted pixel, so it suits single-color icons, not multicolor artwork.
- SVGs referencing external fonts/images render without them. External references are stripped for safety; text in an SVG uses system fonts.
- SVG rasterization is asynchronous. The first preview frame of a new SVG, or of a big zoom change, briefly shows the nearest cached size, then sharpens. Final renders always wait for the exact size.
- Resizing via handles changes the graphic's own width/height. The numeric Scale fields still apply a true transform scale, which scales stroke width too; that's by design, but worth knowing.
