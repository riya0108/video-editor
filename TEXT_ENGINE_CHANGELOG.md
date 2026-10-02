# Text & Typography Engine — Changelog

## Phase 6 (2026-10-02)

### Added
- **Text data model v3** (`src/lib/timeline/text-style.ts`): fontStyle, textAlign (+ justify), verticalAlign, letterSpacing, point/box sizing (boxWidth, boxHeight, maxWidth, maxHeight, overflow), background toggle + color + opacity + padding + radius, stroke toggle, shadow (color, blur, x, y). `normalizeTextStyle` (the only way a style enters the model: defaults, clamps, legacy migration, forward-compatible unknown keys), `patchTextStyle`, `scaleTypography`.
- **Font registry** (`src/lib/text/font-registry.ts`), built on the existing `TEXT_FONTS` list: shipped weights/italics per family, `resolveFont` (guaranteed generic fallback; statuses ok / weight-substituted / unknown-family / invalid), `cssFontString`, `loadFont` (timeout, never throws).
- **Text-aware resize** (`src/lib/text/text-transform.ts`): side handles re-wrap (box width), top/bottom set box height, corners scale typography. Reuses the Phase 5 `resizeFromHandle`; pins the opposite edge or corner.
- **Timeline ops:**
  - `addTextLayer` (track + clip, front, one undo step)
  - `editClips` (atomic content + visual edits)
  - `setCompositionSettings(…, reposition)` with proportional repositioning of layers and guides (default)
- **Engine:** `addTextLayer` (selects the new layer), `editClips`, `setCompositionSettings(patch, reposition)`.
- **Inline text editing** (`TextEditOverlay.tsx`): a textarea overlaid with the exact layer transform and typography. Native caret, selection, IME, copy/paste, newline. Enter / double-click / Add Text open it; Esc / ⌘↵ / click-outside commit; one undo step per session; empty text on commit deletes the layer.
- **Typography inspector** (`TextPanel.tsx`): font, size, weight, bold/italic, text color, layer opacity, alignment, vertical alignment, Auto width / Fixed box, box W/H, auto height, overflow, line height, letter spacing, background, stroke, shadow, font warnings, overflow warning, copy/paste style. Live drafts while scrubbing or picking, one commit per change.
- **Timeline panel** (`TimelinePanel.tsx`): track rows in layer order, clip bars, ruler, playhead, seek; drag-move and edge-trim with snapping to the playhead and clip edges; selection shared with the canvas; Delete.
- **Playground:** "Add text" button; text/inspector wiring; timeline panel.
- **Project format v3:** text styles migrate from v2 (`italic` → `fontStyle`, `align` → `textAlign`, implicit background/stroke) and are normalized on load.
- Docs: `TEXT_ENGINE_ARCHITECTURE.md`, `TEXT_ENGINE_TEST_REPORT.md`, this changelog.
- Tests: `src/lib/text/text-engine.test.ts` (44), v2→v3 migration test, nearest-handle regression test.

### Changed
- `TextStyle` moved from `timeline/visual.ts` to `timeline/text-style.ts` (still re-exported from `visual.ts`). Default font is now the registry id `"geist"` (was a raw CSS stack).
- `text-layout.ts`:
  - letter spacing, justify metadata (`paragraphEnd`), box/point sizing, vertical alignment, overflow, grapheme-safe long-word breaking;
  - alphabetic baselines from real font metrics (`lineBaseline`), replacing `textBaseline = "middle"`;
  - the measurer gained `fontMetrics` and a cache `generation`.
- `draw.ts` `drawText`: background opacity + radius, transform-mapped shadow, outside stroke, native/fallback letter spacing, justify.
- `resolve.ts`: per-content layout cache (`cachedTextLayout`); styles normalized defensively at render time.
- `CompositionPreview.tsx`:
  - text edit mode; text-aware resize via draft timeline;
  - `onCommitEdits` / `onCommitText` / `contentDrafts` props;
  - content drafts are rendered through the same pure `editClips` op used on commit.
- `overlay.ts` `hitSelectionHandle`: picks the **nearest** handle (fixes unreachable side handles on thin layers).
- `setCompositionSettings` now repositions explicit layer positions and guides proportionally by default (`"keep"` restores the old behavior).

### Fixed
- Side resize handles could not be grabbed on short layers (corner-first hit priority).
- `cachedTextLayout` returned inconsistent objects between cache hits and misses.

### Not included (per scope)
Keyframes, kinetic/animated text, captions, transitions, effects, audio, AI features.
