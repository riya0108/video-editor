# Phase 9 — Effects Engine: Architecture

Status: implemented and verified (see `EFFECTS_ENGINE_TEST_REPORT.md`). One refinement during implementation: spatial kernels replicate edge pixels outside the processed region (see the test report). Builds on the composition, keyframe (Phase 8), text, and graphics engines without redesigning them.

## 0. Inspection: where effects plug in

- `drawResolvedFrame` already has an **isolated-layer path** for alpha mattes: the layer is drawn alone onto a scratch canvas, processed, then composited with its opacity and blend. Effects reuse exactly that path, so they apply to **every** layer kind (video, image, PNG, matted subject, text, shape, SVG) with no per-type code.
- The Phase 8 property registry drives keyframes. Effect parameters become animatable by adding a **dynamic resolver** to that registry (`effects.<effectId>.<param>`), with no second animation system.

## 1. Pipeline

```
Layer (clip)
 → Effects (clip.effects: ordered list, params as data)
 → Keyframe evaluation (applyAnimation: transform AND effect params, one engine)
 → Layer content drawn in isolation (render space)  → alpha matte, if any
 → Effect processing, in list order, over the layer's region (+ spill for blur/glow)
 → Compositing (layer opacity + blend mode onto the frame)
```

## 2. Effect abstraction

```ts
interface Effect {
  id: string;                    // effect_id (unique within the clip)
  type: EffectType;              // effect_type (registry key)
  params: Record<string, number>; // parameters (validated against the definition)
  enabled: boolean;
  metadata?: { label?: string; [k: string]: unknown };
}
Clip.effects?: Effect[]           // order = array position (top runs first)
```

| Spec field | Model |
|---|---|
| `effect_id`, `effect_type`, `parameters`, `enabled`, `metadata` | `id`, `type`, `params`, `enabled`, `metadata` |
| `order` | the effect's **index** in `clip.effects`. Not a stored number, because a second order field could disagree with the array. `moveEffect` reorders. |
| `keyframes` | keyframe tracks at `effects.<id>.<param>` in the clip's existing `animation` (Phase 8). `effectKeyframes(clip, id)` returns them. Deleting an effect deletes its tracks. |

**Registry** (`effects/registry.ts`): `EffectDefinition { type, label, category, params: ParamDef[], spill?(params) }`. Params are numeric with min/max/step/default/unit. Spatial params (blur radius, grain size…) are in **composition px** and are multiplied by the render scale at processing time, so a half-resolution preview looks like the full export. Adding an effect = one definition + one kernel; layers, UI, persistence, and keyframes are generic.

## 3. Processing (`effects/process.ts`)

Pure kernels on a `Float32Array` RGBA buffer (0–1, unpremultiplied), with region size, render scale, and frame. CPU, portable, unit-testable with real pixel values in Node.

| Effect | Kernel |
|---|---|
| Brightness | `rgb += amount` |
| Contrast | `rgb = (rgb − 0.5) · (1 + amount) + 0.5` |
| Saturation | mix toward Rec.709 luma by `1 + amount` |
| Exposure | sRGB → linear, `× 2^stops`, → sRGB |
| Temperature | white-balance gains: warm boosts R / cuts B |
| Tint | green ↔ magenta via G gain |
| Blur | 3-pass separable box blur ≈ Gaussian, O(1) per pixel in the radius, on **premultiplied** color (no dark halos at transparent edges) |
| Sharpen | unsharp mask: `c + amount · (c − blur(c))` |
| Vignette | elliptical falloff relative to the **layer's own bounds** (not the canvas) |
| Grain | zero-mean monochrome noise, **deterministic** (hash of position, frame, effect id), so scrubbing and re-rendering are stable and preview = final |
| Glow | bright-pass (above threshold) → blur → screen-add, extending alpha beyond edges |
| Opacity | `alpha × amount` (independent of the layer's opacity; keyframable as an effect) |

Color values are clamped to [0,1] after each effect. The region processed is the layer's render-space bounds, expanded by the effects' spill (blur/glow/sharpen radius) and clamped to the canvas, so small layers are cheap.

## 4. Editing ops (pure, undoable through `TimelineEngine`)

- `addEffect(clipId, type, params?, index?)`
- `removeEffect` (also removes its keyframe tracks)
- `moveEffect(clipId, effectId, newIndex)`
- `setEffectEnabled`
- `updateEffectParams(clipId, effectId, patch, frame?)`: frame-aware like Phase 8 auto-key. An animated param gets a keyframe at the playhead; a static param changes its value.

Duplicate and split copy effects (both halves of a split keep them, so the look is unchanged).

## 5. Persistence

Project format **v6**. `effects` are validated on load: known types, finite params clamped to their definitions, unique ids. Animation paths into effects must reference an existing effect and a real param. Older files have no effects.

## 6. Performance notes

Layers without enabled effects take the unchanged draw path. Layers with effects cost one isolated draw, one `getImageData`/`putImageData` of their region, and the kernels. Blur is O(pixels) regardless of radius. Heavy stacks on large layers will lower the preview frame rate; preview already renders at reduced resolution. A GPU (WebGL) backend could implement the same kernel interface later; it's documented as the scaling path, not built.

## 7. Out of scope

Transitions, LUT import, masks/tracking, audio effects, AI effects.
