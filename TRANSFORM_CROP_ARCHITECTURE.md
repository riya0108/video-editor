# Phase 5 — Transform & Crop Engine

Builds on the timeline engine (`TIMELINE_ARCHITECTURE.md`) and the canvas/preview engine (`COMPOSITION_ARCHITECTURE.md`, Phase 4). Neither architecture was redesigned. The background-removal engine (`src/lib/matting/**`) was **not modified**; its output is consumed as an ordinary source.

## 1. How visual layers are represented (inspection findings)

| Concept | Where | Notes |
|---|---|---|
| Layer | a `Clip` on a `Track` (`timeline/clip.ts`, `track.ts`) | Stacking = `timeline.trackIds` order (index 0 = front). One track holds non-overlapping clips, so each track contributes at most one layer per frame. |
| What it shows | `clip.content` | `video`/`overlay`/`audio` (trimmable source), `image`/`graphic` (source or vector `shape`), `text` (+ `textStyle`). Media is only ever an opaque `MediaSourceRef` (`sourceId`). |
| Where/how it's drawn | `clip.visual?: ClipVisual` (`timeline/visual.ts`) | **The transform data model.** Undefined = derived default (centered, fit "contain"). |
| Canvas geometry | `resolveFrame` / `resolveClipLayer` (`composition/resolve.ts`) | Produces `ResolvedLayer { box, matrix, crop, bounds, visual }`, used by both renderers, hit testing, and the tools. |
| Interaction | `CompositionPreview.tsx` + pure tools in `composition/` | Gestures produce `ClipVisualPatch`es, committed through `TimelineEngine` (undo/redo). |

Kind-agnostic by construction: every non-audio kind resolves to the same `ResolvedLayer` shape, so **one** transform system serves video, images, transparent PNGs, AI/background-removal outputs (an image or matte source), text, shapes/graphics, and overlays. Captions can become text clips on a text track and inherit everything. Future effects can attach to `ClipVisual` / `ResolvedLayer` without touching the tools.

## 2. Transform data model

```ts
interface ClipVisual {
  transform: { x, y, anchorX, anchorY, scaleX, scaleY, rotation, flipX, flipY };
  crop: { top, right, bottom, left };   // normalized 0..1 of the source frame
  opacity: number;                       // 0..1
  blendMode; fit; matte?;
}
```

| Spec name | Model field | Unit |
|---|---|---|
| x, y | `transform.x/y` | composition px (position of the anchor) |
| width, height | **derived**: `layerSize()` = fitted box × scale | composition px; editing them solves for scale (`setLayerSize`) |
| scaleX, scaleY | `transform.scaleX/scaleY` | multiplier, > 0 |
| rotation | `transform.rotation` | degrees clockwise, normalized to (−180, 180] |
| anchorX, anchorY | `transform.anchorX/anchorY` | 0..1 of the layer box |
| opacity | `opacity` | 0..1 (UI shows %) |
| cropTop/Right/Bottom/Left | `crop.top/right/bottom/left` | 0..1 of the source |
| flip horizontal/vertical | `transform.flipX/flipY` | boolean |

**Decision: width/height are derived, not stored.** Storing W/H next to scale would create two sources of truth that can disagree. The project already follows that rule for clip duration (`TIMELINE_ARCHITECTURE.md` §4).

**Decision: validation.** Opacity and crop are clamped (they come from gestures). Non-finite values and scale ≤ 0 are rejected (`invalid-visual`), because they would make a singular matrix. Mirroring is only ever `flip*`, never a negative scale. Crop always leaves ≥ 1% visible.

## 3. Transform matrix and coordinates

Content px → composition px (`resolve.ts` `layerMatrix`, canvas `setTransform` layout):

```
M = T(x,y) · R(rotation) · S(scaleX·±1, scaleY·±1) · T(−anchor·box) · S(box/content)
box = fitBox(content size, composition size, fit)   // contain / cover / fill / none
```

`transform-tools.ts` works in **box space** (`p = pos + R·S·(u − anchor·box)`), with `boxToComp` / `compToBox` as the conversions. A unit test asserts they agree exactly with `layerMatrix`. Other spaces: render (comp × renderScale) and screen (comp × zoom + pan); see `COMPOSITION_ARCHITECTURE.md` §1.

## 4. Operations (all pure, all undoable through `TimelineEngine`)

| Capability | Function(s) |
|---|---|
| Move | `translateVisual`; canvas drag; arrows (Shift ×10) |
| Resize | `resizeFromHandle` (opposite handle pinned; corners keep aspect, Shift frees; Alt = about anchor), `setLayerSize` (numeric W/H) |
| Rotate | `rotateFromPointer` (about anchor, Shift = 15°), magnetic 0/90/180/270, `[` `]` keys |
| Anchor | `moveAnchorTo`, `setAnchorNormalized` (9-point grid): position and anchor re-solve together, so **the layer never moves** |
| Crop | `cropFromHandle` (crop mode / C) and numeric fields; crops in place, the layer doesn't move |
| Flip | `flipX/flipY` toggles (H/V, panel) |
| Opacity | numeric field / scrub |
| Bounding box & handles | `visibleBounds`, `handleCompPoints`, `selectionLayout`, `hitSelectionHandle`, rotation-aware `handleCursor` |
| Center / edge alignment | `alignDelta` (one layer → canvas or safe zone), `alignMany` (several → their shared bounds, canvas, or safe zone) |
| Center guides / snapping | `buildSnapTargets` (canvas edges and center, ruler guides, safe zones, other layers' edges and centers), `snapRect` / `snapPoint` / `snapValue`; ⌘/Ctrl suspends |
| Multi-select | Engine `Selection`; Shift-click, marquee (`marqueeHits`), ⌘A; group box from `unionBounds` |
| Multi-object movement | group drag / nudge → `setClipVisuals` (**atomic**: validates every clip and lock first, all or nothing) |
| Duplicate | `duplicateClipsAsLayers`: new layer(s) of the same kind stacked directly above, same timing, offset +24 px, sharing the same `MediaSourceRef`. ⌘D. One undo step. |
| Undo / redo | Existing snapshot history. One undo step per gesture: drags, held keys, and scrubs commit once on release, and unchanged values commit nothing. |
| Save / reload | `serializeTimeline` / `deserializeTimeline` (versioned envelope, full validation, v1→v2 upgrade, **id reservation**), `engine.loadTimeline` |

## 5. Key decisions

- **Non-destructive by construction.** A transform only changes numbers in `ClipVisual`. Each frame redraws the original source through a single matrix (one resample, from source), and text and shapes are re-rasterized as vectors at output scale. Nothing caches a transformed bitmap, so repeated edits can't compound loss. Media is referenced, never embedded or copied, including by duplicate and save.
- **⌘/Ctrl is not a selection modifier.** Found in testing: when ⌘ both suspended snapping and toggled selection, pressing ⌘ to drag precisely *deselected* the layer. Selection toggling is now Shift only.
- **Empty-canvas drag = marquee** (was pan in Phase 4); pan is Space/middle-drag/wheel, matching Figma/AE.
- **Duplicate means a new layer**, not a later-in-time copy. That is what the canvas user means. The existing `duplicateClip` (timeline sense) is unchanged.
- **Multi-selection handles:** a group shows member outlines and a union box, with move/nudge/rotate-each/flip-each/align/duplicate/delete. No group scale/rotate handles (see limitations).
- **Ids survive reload.** `createId` uses module-level counters, so a fresh session would restart at `clip-1` and silently overwrite a loaded clip. `deserializeTimeline` calls `reserveIds`. This was caught by a test that fails without the fix.

## 6. Files

Created:
- `TRANSFORM_CROP_ARCHITECTURE.md`
- `src/lib/timeline/serialize.ts`, `serialize.test.ts`
- `src/lib/composition/multi-select.ts`, `transform-crop.test.ts`
- `src/components/tool/video/composition/MultiSelectionPanel.tsx`

Created earlier in this phase's transform pass (uncommitted, part of the same feature): `composition/transform-tools.ts`, `snap.ts`, `safe-zones.ts`, `align.ts`, `overlay.ts` (+ tests), `TransformPanel.tsx`.

Modified:
- `src/lib/timeline/operations.ts`: `setClipVisuals`, `duplicateClipsAsLayers`, guides ops
- `src/lib/timeline/engine.ts`: `setClipVisuals`, `duplicateClipsAsLayers`, `loadTimeline`, `resetHistory`, guides
- `src/lib/timeline/id.ts`: `reserveIds`
- `src/lib/timeline/model.ts`: `guides`
- `src/lib/timeline/errors.ts`, `src/lib/timeline/index.ts`
- `src/lib/composition/resolve.ts`: `box`, `resolveClipLayer`
- `src/lib/composition/overlay.ts`: multi-selection and marquee
- `src/lib/composition/index.ts`
- `src/components/tool/video/composition/CompositionPreview.tsx`: multi-select, marquee, group move, ⌘D / Delete / ⌘A, modifier fix
- `src/components/tool/video/composition/CompositionPlaygroundPanel.tsx`: engine selection, multi panel, Save/Load

Not modified: anything under `src/lib/matting/**`.

## 7. Testing

**Automated** (Vitest, Node): `transform-crop.test.ts` has one `describe` per required item (move, resize, rotate, crop, flip, opacity, anchor, undo/redo, multi-select, snapping, portrait, landscape, square, transparent, background-removed, source immutability). `serialize.test.ts` covers save/reload. Geometry is asserted through `resolveFrame` (what's drawn, not just stored numbers).
- Transparent and background-removed drawing is checked with a recording 2D context and a **read-only source proxy that throws on any write**.
- Immutability is checked by **deep-freezing** the input timeline.
- Mutation-checked: making an op mutate its input fails 2 tests, and removing id reservation fails the reload test.

**Manual / live** (chrome-devtools-mcp, real decode, real uploads through *Add media*):
- Portrait video 720×1280, landscape video 1280×720 (ffmpeg testsrc2), square JPEG 800×800, transparent PNG 600×400 with a 50%-alpha region, a **background-removed subject** produced by the unmodified `removeBackgroundFromImage` (u2net, confidence 0.984, 58k soft-edge pixels), text, and shape.
- For each, via real canvas pointer and keyboard events and the numeric field:
  - move landed exactly (+60, +40), and the corner resize kept the opposite corner pinned at 0.000 px drift with aspect preserved;
  - rotate 15°, crop-left 25%, flip H, and opacity 70% all applied;
  - exactly 6 undo steps, undo/redo exact, only the target clip edited, layer present in the final render;
  - **source pixels hashed identical before/after**.
- Multi-select: Shift-click, marquee (3 layers), and group move (+100, +50) each as one undo step; Shift+← ×3 moved all three; align-left gave a shared x of 208; ⌘D made 3 copies in one step; Delete and undo restored counts.
- Transparent output: final-render alpha 128 / 255 / 0 matches the PNG source, and canvas corners are 0.
- Save → full page reload → Load: visuals identical, built-in media relinked, uploads reported as missing, a new clip id didn't collide.

## 8. Known limitations

- No group scale/rotate handles for multi-selections; rotation/flip/scale keys apply to each member about its own anchor.
- Resize-handle snapping only applies when the layer is axis-aligned (rotation a multiple of 90°).
- A drag that starts exactly on a selected layer's anchor crosshair moves the anchor (Premiere behavior); grab elsewhere to move.
- Width/height are of the uncropped box × scale; the visible (cropped) size isn't shown separately.
- Media isn't embedded in saved projects. Uploads from a previous session must be re-added to relink; the playground lists them on load.
- Captions in the existing single-track Video Editor don't use this engine yet. The engine supports them as text clips, but that migration isn't done.
- Out of scope per the brief: effects, keyframes, transitions, audio, AI features. Alt-drag-to-duplicate and distribute-spacing aren't built.

## 9. Technical debt

- `CompositionPreview.tsx` has grown large (~750 lines). The gesture state machine is a candidate to extract into a `useTransformInteraction` hook.
- Multi-member moves can store values like `1599.9999999999998` (float accumulation through `translateVisual`). Harmless to geometry, but noisy in saved files; rounding on commit would need care around anchor exactness.
- The playground's "Add media" path and the Save/Load relink logic live in the internal playground, not a reusable project/media-library layer.
- Dev-only: after a dev-server restart, a page that dynamically imports the matting pipeline from an already-open tab can hit Vite's "504 Outdated Optimize Dep" (stale dependency hash). A clean restart plus a fresh load fixes it. This is the same class as the earlier `@huggingface/transformers` issue in memory. No config change was needed this time, but `onnxruntime-web` / `@mediapipe/tasks-vision` are candidates for `optimizeDeps.include` if it recurs.
- Everything since the timeline-engine commit (Phase 4 + transform + Phase 5) is still **uncommitted**.
