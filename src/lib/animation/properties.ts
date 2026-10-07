import type { Clip } from "../timeline/clip";
import { defaultClipVisual, normalizeCrop, type ClipVisual } from "../timeline/visual";
import { evaluateTrack, type ClipAnimation, type PropertyPath } from "./keyframes";
import { clampParam, parseEffectPath } from "../effects/model";
import { clampGainDb, clampVolume, clipAudioOf } from "../audio/model";
import { clampMaskParam, MASK_PARAM_LABELS, parseMaskPath } from "../masks/model";

/**
 * ANIMATABLE PROPERTY REGISTRY (KEYFRAME_ENGINE_ARCHITECTURE.md §3).
 *
 * A property is a path plus get/set on a Clip. The evaluator, persistence,
 * undo, inspector and renderer integration are all generic over this
 * registry — animating text size, shape radius, an effect parameter, a mask
 * or caption property later is ONE new entry here, not a new system.
 */

export interface CompSize {
  width: number;
  height: number;
}

export interface AnimatableProperty {
  path: PropertyPath;
  label: string;
  /** Current (static) value on the clip. */
  get(clip: Clip, comp: CompSize): number;
  /** Returns a clip with the value applied (never mutates). */
  set(clip: Clip, value: number, comp: CompSize): Clip;
}

const vis = (clip: Clip, comp: CompSize): ClipVisual => clip.visual ?? defaultClipVisual(comp.width, comp.height);

function transformProp(key: "x" | "y" | "scaleX" | "scaleY" | "rotation", label: string, clamp: (v: number) => number = (v) => v): AnimatableProperty {
  return {
    path: `visual.transform.${key}`,
    label,
    get: (c, comp) => vis(c, comp).transform[key],
    set: (c, v, comp) => {
      const base = vis(c, comp);
      return { ...c, visual: { ...base, transform: { ...base.transform, [key]: clamp(v) } } };
    },
  };
}

function cropProp(side: "top" | "right" | "bottom" | "left", label: string): AnimatableProperty {
  return {
    path: `visual.crop.${side}`,
    label,
    get: (c, comp) => vis(c, comp).crop[side],
    set: (c, v, comp) => {
      const base = vis(c, comp);
      return { ...c, visual: { ...base, crop: normalizeCrop({ ...base.crop, [side]: v }) } };
    },
  };
}

const MIN_SCALE = 0.001;

export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  transformProp("x", "Position X"),
  transformProp("y", "Position Y"),
  transformProp("scaleX", "Scale X", (v) => Math.max(MIN_SCALE, v)),
  transformProp("scaleY", "Scale Y", (v) => Math.max(MIN_SCALE, v)),
  // Deliberately NOT wrapped to (-180,180]: animating 0 -> 720 spins twice.
  transformProp("rotation", "Rotation"),
  {
    path: "visual.opacity",
    label: "Opacity",
    get: (c, comp) => vis(c, comp).opacity,
    set: (c, v, comp) => ({ ...c, visual: { ...vis(c, comp), opacity: Math.min(1, Math.max(0, v)) } }),
  },
  cropProp("top", "Crop top"),
  cropProp("right", "Crop right"),
  cropProp("bottom", "Crop bottom"),
  cropProp("left", "Crop left"),
  // AUDIO (Phase 11, AUDIO_ENGINE_ARCHITECTURE.md §3): volume automation and gain automation on any clip that carries sound.
  {
    path: "audio.volume",
    label: "Volume",
    get: (c) => clipAudioOf(c).volume,
    set: (c, v) => ({ ...c, audio: { ...clipAudioOf(c), volume: clampVolume(v) } }),
  },
  {
    path: "audio.gainDb",
    label: "Gain",
    get: (c) => clipAudioOf(c).gainDb,
    set: (c, v) => ({ ...c, audio: { ...clipAudioOf(c), gainDb: clampGainDb(v) } }),
  },
];

/** Paths that animate a clip's SOUND (valid on audio/video/overlay clips) rather than its picture. */
export function isAudioPath(path: string): boolean {
  return path.startsWith("audio.");
}

const BY_PATH = new Map(ANIMATABLE_PROPERTIES.map((p) => [p.path, p]));

/**
 * DYNAMIC PROPERTIES: paths whose shape is a pattern rather than a fixed list
 * (e.g. effects.<effectId>.<param> — one per effect instance). A resolver
 * builds the AnimatableProperty on demand, so the evaluator, keyframe ops,
 * persistence and UI treat them exactly like static entries.
 */
type PropertyResolver = (path: PropertyPath) => AnimatableProperty | undefined;
const RESOLVERS: PropertyResolver[] = [];

export function registerPropertyResolver(resolver: PropertyResolver): void {
  RESOLVERS.push(resolver);
}

export function getProperty(path: PropertyPath): AnimatableProperty | undefined {
  const fixed = BY_PATH.get(path);
  if (fixed) return fixed;
  for (const r of RESOLVERS) {
    const p = r(path);
    if (p) return p;
  }
  return undefined;
}

export function isAnimatablePath(path: string): boolean {
  return getProperty(path) !== undefined;
}

// Effect parameters: effects.<effectId>.<param>, resolved against the clip's effect stack.
registerPropertyResolver((path) => {
  const parsed = parseEffectPath(path);
  if (!parsed) return undefined;
  const { effectId, param } = parsed;
  const findEffect = (c: Clip) => c.effects?.find((e) => e.id === effectId);
  return {
    path,
    label: param,
    get: (c) => findEffect(c)?.params[param] ?? NaN,
    set: (c, v) => {
      const e = findEffect(c);
      if (!e || !(param in e.params)) return c;
      return { ...c, effects: c.effects!.map((x) => (x === e ? { ...x, params: { ...x.params, [param]: clampParam(x.type, param, v) } } : x)) };
    },
  };
});

// Mask params (Phase 13): masks.<maskId>.<param>, resolved against the clip's mask list.
registerPropertyResolver((path) => {
  const parsed = parseMaskPath(path);
  if (!parsed) return undefined;
  const { maskId, param } = parsed;
  const findMask = (c: Clip) => c.masks?.find((m) => m.id === maskId);
  return {
    path,
    label: MASK_PARAM_LABELS[param],
    get: (c) => findMask(c)?.[param] ?? NaN,
    set: (c, v) => {
      const m = findMask(c);
      const clamped = clampMaskParam(param, v);
      if (!m || clamped === null) return c;
      return { ...c, masks: c.masks!.map((x) => (x === m ? { ...x, [param]: clamped } : x)) };
    },
  };
});

/** Extension point: register another animatable property (text, shape, effect, mask, caption, audio...). */
export function registerAnimatableProperty(p: AnimatableProperty): void {
  if (BY_PATH.has(p.path)) throw new Error(`Animatable property "${p.path}" is already registered.`);
  (ANIMATABLE_PROPERTIES as AnimatableProperty[]).push(p);
  BY_PATH.set(p.path, p);
}

/**
 * THE evaluation step: returns the clip as it looks at `localFrame`
 * (clip-relative), with every animated property replaced by its interpolated
 * value. A clip without animation is returned AS IS (same object) — static
 * layers take exactly the pre-animation code path.
 */
export function applyAnimation(clip: Clip, localFrame: number, comp: CompSize): Clip {
  const anim: ClipAnimation | undefined = clip.animation;
  if (!anim) return clip;
  let out = clip;
  for (const [path, track] of Object.entries(anim.tracks)) {
    const prop = getProperty(path);
    if (!prop || track.keyframes.length === 0) continue;
    out = prop.set(out, evaluateTrack(track, localFrame), comp);
  }
  return out;
}

/** Value of a property at a clip-relative frame (animated if it has keyframes, else static). */
export function valueAt(clip: Clip, path: PropertyPath, localFrame: number, comp: CompSize): number {
  const prop = getProperty(path);
  if (!prop) return NaN;
  const track = clip.animation?.tracks[path];
  return track && track.keyframes.length ? evaluateTrack(track, localFrame) : prop.get(clip, comp);
}
