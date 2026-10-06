/**
 * EFFECT REGISTRY (EFFECTS_ENGINE_ARCHITECTURE.md §2). Each effect is a
 * definition (params with ranges/defaults/units) + a kernel in process.ts.
 * Adding an effect never touches layer types, UI, persistence or keyframes —
 * those are generic over this registry.
 *
 * Spatial params are in COMPOSITION px and are scaled by the render scale at
 * processing time, so a reduced-resolution preview matches the full export.
 */

export type EffectType =
  | "brightness"
  | "contrast"
  | "saturation"
  | "exposure"
  | "temperature"
  | "tint"
  | "blur"
  | "sharpen"
  | "vignette"
  | "grain"
  | "glow"
  | "opacity";

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Display unit; "%" params are stored as fractions (0.25) and shown x100. */
  unit: "" | "%" | "px" | "stops";
  /** Composition-px length: multiplied by the render scale during processing. */
  spatial?: boolean;
}

export interface EffectDefinition {
  type: EffectType;
  label: string;
  category: "color" | "detail" | "stylize";
  params: readonly ParamDef[];
  /** How far (composition px) the effect can spread pixels beyond the layer's bounds. */
  spill?: (p: Readonly<Record<string, number>>) => number;
}

const pct = (key: string, label: string, min: number, max: number, def = 0): ParamDef => ({ key, label, min, max, step: 0.01, default: def, unit: "%" });

export const EFFECT_DEFINITIONS: readonly EffectDefinition[] = [
  { type: "brightness", label: "Brightness", category: "color", params: [pct("amount", "Amount", -1, 1)] },
  { type: "contrast", label: "Contrast", category: "color", params: [pct("amount", "Amount", -1, 1)] },
  { type: "saturation", label: "Saturation", category: "color", params: [pct("amount", "Amount", -1, 1)] },
  { type: "exposure", label: "Exposure", category: "color", params: [{ key: "stops", label: "Exposure", min: -5, max: 5, step: 0.05, default: 0, unit: "stops" }] },
  { type: "temperature", label: "Temperature", category: "color", params: [pct("amount", "Warm ↔ cool", -1, 1)] },
  { type: "tint", label: "Tint", category: "color", params: [pct("amount", "Green ↔ magenta", -1, 1)] },
  {
    type: "blur",
    label: "Blur",
    category: "detail",
    params: [{ key: "radius", label: "Radius", min: 0, max: 200, step: 0.5, default: 8, unit: "px", spatial: true }],
    spill: (p) => p.radius * 1.5,
  },
  {
    type: "sharpen",
    label: "Sharpen",
    category: "detail",
    params: [pct("amount", "Amount", 0, 3, 0.6), { key: "radius", label: "Radius", min: 0.5, max: 20, step: 0.5, default: 2, unit: "px", spatial: true }],
    spill: (p) => p.radius * 1.5,
  },
  {
    type: "vignette",
    label: "Vignette",
    category: "stylize",
    params: [pct("amount", "Amount", 0, 1, 0.5), pct("size", "Size", 0, 1, 0.5), pct("softness", "Softness", 0.01, 1, 0.5)],
  },
  {
    type: "grain",
    label: "Grain",
    category: "stylize",
    params: [pct("amount", "Amount", 0, 1, 0.25), { key: "size", label: "Size", min: 1, max: 20, step: 0.5, default: 1.5, unit: "px", spatial: true }],
  },
  {
    type: "glow",
    label: "Glow",
    category: "stylize",
    params: [
      { key: "radius", label: "Radius", min: 0, max: 200, step: 0.5, default: 24, unit: "px", spatial: true },
      pct("intensity", "Intensity", 0, 3, 1),
      pct("threshold", "Threshold", 0, 1, 0.6),
    ],
    spill: (p) => p.radius * 1.5,
  },
  { type: "opacity", label: "Opacity", category: "stylize", params: [pct("amount", "Amount", 0, 1, 1)] },
];

const BY_TYPE = new Map(EFFECT_DEFINITIONS.map((d) => [d.type, d]));

export function getEffectDefinition(type: string): EffectDefinition | undefined {
  return BY_TYPE.get(type as EffectType);
}

export function isEffectType(type: unknown): type is EffectType {
  return typeof type === "string" && BY_TYPE.has(type as EffectType);
}
