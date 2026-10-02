# Phase 6 — Text & Typography Engine: Architecture

Status: design written before implementation; implemented and verified (see `TEXT_ENGINE_TEST_REPORT.md`). Two notes were added during implementation, in §5 (handle picking) and §12 (APIs). Builds on — and does not replace — the timeline engine (`TIMELINE_ARCHITECTURE.md`), the canvas/preview engine (`COMPOSITION_ARCHITECTURE.md`), and the transform system (`TRANSFORM_CROP_ARCHITECTURE.md`).

## 0. What already existed (inspection)

| Piece | Where | Reused as |
|---|---|---|
| Text clip kind | `timeline/clip.ts`: `{ kind: "text", text, textStyle?, durationFrames }` on a `text` track | **The** text layer. No new layer type. |
| Text style | `timeline/visual.ts` `TextStyle` (family, size, weight, italic, color, align, lineHeight, maxWidth, backgroundColor, padding, stroke) | Extended in place (moved to `timeline/text-style.ts`, re-exported from `visual.ts`). |
| Layout | `composition/text-layout.ts` (greedy wrap, injected measurer, composition-px measuring, per-string cache) | Extended: letter spacing, justify, box mode, vertical align, overflow, long-word breaking. |
| Drawing | `composition/draw.ts` `drawText` (vector `fillText`/`strokeText` under the layer matrix) | Extended: shadow, background opacity/radius, letter spacing, justify. |
| Placement | `ClipVisual` (position, scale, rotation, anchor, opacity, crop, flip, blend) | Unchanged. Text uses it like every other layer. |
| Interaction | `CompositionPreview` (select, handles, snapping, multi-select) | Extended with **text edit mode** and text-aware resize. |
| History / persistence | `TimelineEngine` snapshot history, `timeline/serialize.ts` | Same stack. Project format v3 adds a text-style migration. |
| Fonts | `lib/ffmpeg/fonts.ts` `TEXT_FONTS` (id → CSS family + ttf for ffmpeg), `@fontsource` imports in `global.css` | **Extended** by a registry (`lib/text/font-registry.ts`) built on that same list. No second font list. |

Missing before this phase: a timeline *view* for the new engine (the engine had move/trim, nothing drew it), inline editing, a font abstraction with fallback, and text-specific resize semantics.

## 1. Text layer data model

A text layer = a `text` clip. Content (what) and placement (where) stay separate, exactly as for media:

```
Clip { id, trackId, timelineStart,
       content: { kind: "text", text: string, textStyle: TextStyle, durationFrames },
       visual?: ClipVisual }          // position, scale, rotation, anchor, opacity, crop, flip, blend
```

`TextStyle` (all lengths in composition px, so preview scale and export scale can't disagree):

| Group | Fields |
|---|---|
| Font | `fontFamily` (registry id or CSS family), `fontSize`, `fontWeight` (100–900), `fontStyle` ("normal" \| "italic") |
| Fill | `color` (CSS color) |
| Paragraph | `textAlign` (left/center/right/justify), `verticalAlign` (top/middle/bottom), `lineHeight` (× fontSize), `letterSpacing` (px) |
| Box | `sizing` ("point" \| "box"), `boxWidth`, `boxHeight?` (undefined = auto height), `maxWidth?` (point-mode wrap cap), `maxHeight?`, `overflow` ("visible" \| "clip") |
| Background | `background` (on/off), `backgroundColor`, `backgroundOpacity`, `padding`, `borderRadius` |
| Stroke | `stroke` (on/off), `strokeColor`, `strokeWidth` |
| Shadow | `shadow` (on/off), `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` |

Spec fields that are **deliberately not duplicated** in `TextStyle`, because the generic layer model already owns them: `id`, `type` (clip id / content.kind); `opacity`, `position`, `transform`, `rotation`, `anchorPoint` (`ClipVisual`); `width`/`height`, which are the *laid-out* box size, derived from layout (point text) or `boxWidth`/`boxHeight` (box text). Storing them twice would create two sources of truth.

**Toggle + value fields** (`background`/`backgroundColor`, etc.): turning an effect off keeps its settings, so turning it back on restores them, and the off-state is explicit rather than "color undefined".

**Normalization, not trust.** `normalizeTextStyle(raw)` is the only way a style enters the model. It fills defaults, migrates legacy names (`italic` → `fontStyle`, `align` → `textAlign`, `backgroundColor`-implies-`background`, `strokeColor`-implies-`stroke`), clamps ranges (fontSize 1–2000, lineHeight 0.5–5, …), and replaces invalid values with defaults. It runs on edit, on render (defensive), and on project load.

**Future compatibility.** Reserved, documented-but-unimplemented extension points: `fill` (gradient text), `runs` (per-word/char style spans over `text` ranges), `fontVariations` (variable-font axes), `textMask`. Animation/keyframes will target the same property paths (`content.textStyle.fontSize`, `visual.transform.rotation`) because every property is a plain number/string in one place. The project envelope version (v3) gates migrations.

## 2. Font management (`lib/text/font-registry.ts`)

- Built from `TEXT_FONTS` plus per-font metadata (available weights/italics, matching the `@fontsource` imports actually shipped).
- `resolveFont(style)` → `{ cssFamily, weight, style, status, warnings }`:
  - known id → that font's CSS stack (always ends in a generic family);
  - unknown family string → used as-is with a generic fallback appended, status `"unknown"`;
  - empty/invalid → default font, status `"invalid"`;
  - requested weight not shipped → nearest shipped weight, with a warning (the browser would otherwise synthesize faux-bold).
- `loadFont` / `ensureFontsForStyles` wrap `document.fonts.load` with a timeout. A failure resolves to a fallback status; it never throws into the editor.
- `cssFont(style)` (text-layout) uses the resolved stack, so **a missing font can only ever render in a fallback face. It cannot crash or render nothing.**
- `FinalRenderer` already awaits fonts before measuring (Phase 4); it now goes through the registry.

## 3. Measurement & layout (`composition/text-layout.ts`)

Pipeline: `text → paragraphs (\n) → words → lines → TextLayout`.
- Measurement in composition px with `letterSpacing` applied (`ctx.letterSpacing` where supported, otherwise per-grapheme advance + spacing), cached per (font, spacing, string).
- Wrap width = `boxWidth − 2·padding` (box) or `maxWidth` (point); none → only manual breaks.
- A single word wider than the wrap width breaks at grapheme boundaries (`Intl.Segmenter`), so CJK, URLs, and long tokens never overflow silently.
- Line height = `fontSize × lineHeight`. Box height = `boxHeight` (box mode) or content height; `maxHeight` caps it. `overflowed` is reported for the UI when content exceeds a fixed height, and `overflow: "clip"` clips drawing to the box.
- Vertical alignment offsets the line block inside a taller fixed box.
- Output `TextLayout { lines[{text, width, paragraphEnd}], width, height, contentTop, lineHeightPx, overflowed }`. It's pure, so it's unit-testable with a fake measurer.
- **Layout cache:** content objects are immutable, so `resolve.ts` caches the layout per (content object, measurer generation). It is rebuilt only when that clip's text/style changes or fonts finish loading, not every frame.

## 4. Rendering pipeline

```
Timeline ─► resolveFrame (layer evaluation: active clips, z-order, ClipVisual)
          ─► layoutText (cached)              ─► ResolvedLayer{content:"text", layout, style, matrix}
          ─► drawResolvedFrame → drawText     (background → shadow → stroke → fill, in content space)
          ─► layer matrix (transform)  ─► composite (opacity, blend, z-order)  ─► preview raster / final frame
```

- Text is drawn as **vectors at the render scale** (`fillText` under the full matrix), never rasterized and scaled, so it's sharp in preview and at export resolution. Preview and final share this exact code (Phase 4 guarantee), so there is no preview-only text representation.
- Baseline: lines are positioned by `alphabetic` baseline using font ascent/descent metrics from `measureText` (`fontBoundingBoxAscent/Descent`, fallback 0.8/0.2 em), so line boxes are stable across fonts and glyph content.
- Shadows: canvas `shadow*` ignores the current transform, so offsets are mapped through the layer matrix and blur is scaled by the matrix scale. The shadow therefore rotates/scales with the text and is identical (proportionally) in preview and final. The shadow is cast by one pass only, so stroke + fill don't double it.
- Stroke is drawn outside the glyph (2× width, fill on top). The background is a rounded rect of the whole box, with its own opacity.

## 5. Transform integration

No second transform system. Text gets move/scale/rotate/anchor/opacity/crop/flip/blend from `ClipVisual` and the Phase 5 tools unchanged. The **only** text-specific rule is what resize handles mean, so glyphs are never distorted:
- **Side handles** (e/w): switch to box mode and change `boxWidth` → re-wrap. (n/s): set `boxHeight`.
- **Corner handles:** scale the typography (fontSize, letterSpacing, padding, stroke, shadow, radius, box size) proportionally, keeping the transform scale unchanged.
- Numeric scale fields still exist (it's a generic layer), but the default gestures edit layout, not pixels.

Implemented by mapping the generic `resizeFromHandle` result (which already pins the opposite corner) onto a combined content + visual edit (`editClips`, one atomic op / one undo step). During the drag the preview renders a *draft timeline* produced by the same pure `editClips` op the commit uses, so the live preview can't diverge from the committed result.

*Added during implementation:* handle picking (`hitSelectionHandle`) chooses the **nearest** handle within the hit radius. A single line of text is short enough that its corner handles fall inside the side handles' hit radius, and the original corners-first order made side handles (text re-wrap) impossible to grab.

## 6. Selection & editing integration

Two modes, visually distinct:
- **Object mode** (Phase 5): click selects, drag moves, handles resize/rotate.
- **Text edit mode:** entered by double-clicking a text layer, pressing Enter with it selected, or automatically after **Add Text**. A transparent-background `<textarea>` is overlaid with the exact layer transform (CSS matrix = viewport × layer matrix) and the same font/size/spacing/alignment, while the canvas copy is hidden. Native caret, selection, select-all, copy/paste, IME, Backspace/Delete, Enter (newline) all work. A dashed accent frame and an "Editing text" badge mark the mode, and object handles are hidden.
- Esc, clicking outside, or ⌘/Ctrl+Enter commits. The whole edit session is **one undo step**. Committing empty text deletes the layer (the delete is undoable).
- The canvas key handler ignores keys while editing, so typing never nudges/flips/deletes the object.

## 7. Timeline integration

Text clips are ordinary clips, so add/move/trim/extend/delete/duplicate/reorder use existing engine ops. New: a `TimelinePanel` view for the composition engine (track rows, clip bars, ruler, playhead) with drag-move, edge-trim, playhead and edge snapping (existing `snapping.ts`), and click-to-select shared with the canvas selection. Visibility by duration is already enforced by `resolveFrame` (active iff `start ≤ frame < end`).

## 8. Composition changes

`setCompositionSettings` gains `reposition: "proportional"` (the default in the UI): explicit positions and guides are scaled by the size ratio, so text stays where it was relative to the frame (e.g. lower-third stays lower-third) when switching 1920×1080 ↔ 1080×1920 ↔ 1080×1080. Sizes are not scaled. `"keep"` preserves the old behavior.

## 9. Persistence

Text is plain JSON inside the clip. The project format goes **v2 → v3**: on load every `textStyle` passes through `normalizeTextStyle` (migrates v2 names, validates). Save → reload produces the same layout (verified by pixel comparison of final renders).

## 10. Error handling

| Case | Behavior |
|---|---|
| Missing/unknown font | Generic fallback face; status/warning shown in the inspector |
| Invalid style values | Normalized to defaults/clamped |
| Empty text | Not drawn. While editing, the textarea still shows; empty on commit deletes the layer |
| Huge / tiny font size | Clamped to 1–2000 px |
| Extremely long text / long words | Grapheme-level breaking; layout cost bounded by caching |
| Unicode / emoji / RTL glyphs | Drawn by the platform text stack; graphemes never split mid-cluster |
| Huge text boxes | Box clamped to 1–20000 px |

## 11. Performance

Layout is cached per immutable content object (rebuilt only when that clip's text/style changes or fonts finish loading). Glyph widths are cached per (font, spacing, string) and font metrics per font. Only clips whose content changed are re-laid-out. Rendering cost stays per-frame vector drawing, which is what keeps text sharp at every scale.

## 12. Public API summary

| Module | API |
|---|---|
| `timeline/text-style.ts` | `TextStyle`, `DEFAULT_TEXT_STYLE`, `TEXT_LIMITS`, `normalizeTextStyle`, `patchTextStyle`, `scaleTypography`, `TextStylePatch` |
| `timeline/operations.ts` / `TimelineEngine` | `addTextLayer`, `updateAuthoredContent` (text, textStyle patch), `editClips`, `setCompositionSettings(patch, reposition)`, plus every existing clip op (move/trim/duplicate/delete/reorder) |
| `text/font-registry.ts` | `FONT_FACES`, `getFontFace`, `resolveFont`, `cssFontString`, `loadFont` |
| `text/text-transform.ts` | `textResize` |
| `composition/text-layout.ts` | `layoutText`, `lineX`, `lineBaseline`, `graphemes`, `createCanvasTextMeasurer`, `TextMeasurer` |
| `composition/resolve.ts` | `cachedTextLayout` |
| Components | `TextEditOverlay`, `TextPanel`, `TimelinePanel`; `CompositionPreview` props `editingTextClipId`, `onEditingTextClipIdChange`, `onCommitText`, `onCommitEdits`, `contentDrafts` |

## 13. Out of scope (Phase 6)

Keyframes, kinetic/animated text, captions, transitions, effects, audio, AI. The data model leaves room for them (§1).
