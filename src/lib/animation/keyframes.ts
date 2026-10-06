import { easingFn, normalizeEasing, type EasingSpec } from "./easing";

/**
 * KEYFRAMES (KEYFRAME_ENGINE_ARCHITECTURE.md §2). Pure data + pure functions.
 * A track is one property's keyframes, sorted by frame with unique frames.
 * `frame` is CLIP-RELATIVE (0 = the clip's first frame), so a moved clip
 * carries its animation with it.
 */

/** Dotted path into a Clip, e.g. "visual.transform.x" — see properties.ts for the registry. */
export type PropertyPath = string;

export interface Keyframe {
  id: string;
  /** Clip-relative integer frame. */
  frame: number;
  value: number;
  /** Easing of the OUTGOING segment (this keyframe -> the next). */
  easing: EasingSpec;
}

export interface KeyframeTrack {
  keyframes: Keyframe[];
}

export interface ClipAnimation {
  tracks: Record<PropertyPath, KeyframeTrack>;
}

let kfCounter = 0;
export function createKeyframeId(): string {
  kfCounter += 1;
  return `kf-${Date.now().toString(36)}-${kfCounter}`;
}

/** Value of a track at a clip-relative frame. Holds the first value before the first key and the last after the last. */
export function evaluateTrack(track: KeyframeTrack, frame: number): number {
  const ks = track.keyframes;
  if (ks.length === 0) return NaN;
  if (frame <= ks[0].frame) return ks[0].value;
  const last = ks[ks.length - 1];
  if (frame >= last.frame) return last.value;
  // Binary search for the segment [a, b] containing frame.
  let lo = 0;
  let hi = ks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ks[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = ks[lo];
  const b = ks[hi];
  const t = (frame - a.frame) / (b.frame - a.frame);
  return a.value + (b.value - a.value) * easingFn(a.easing)(t);
}

export function sortKeyframes(ks: readonly Keyframe[]): Keyframe[] {
  return [...ks].sort((x, y) => x.frame - y.frame);
}

export function keyframeAt(track: KeyframeTrack | undefined, frame: number): Keyframe | undefined {
  return track?.keyframes.find((k) => k.frame === frame);
}

/** Insert or replace the keyframe at `frame` (keeps an existing key's id/easing when replacing its value). */
export function upsertKeyframe(track: KeyframeTrack | undefined, frame: number, value: number, easing?: EasingSpec): KeyframeTrack {
  const ks = track?.keyframes ?? [];
  const existing = ks.find((k) => k.frame === frame);
  if (existing) return { keyframes: ks.map((k) => (k === existing ? { ...k, value, easing: easing ?? k.easing } : k)) };
  return { keyframes: sortKeyframes([...ks, { id: createKeyframeId(), frame, value, easing: easing ?? { type: "linear" } }]) };
}

/** Next/previous keyframe frame across the given tracks (for prev/next navigation). */
export function adjacentKeyframeFrame(tracks: readonly KeyframeTrack[], frame: number, dir: 1 | -1): number | undefined {
  let best: number | undefined;
  for (const t of tracks) {
    for (const k of t.keyframes) {
      if (dir > 0 ? k.frame > frame : k.frame < frame) {
        if (best === undefined || (dir > 0 ? k.frame < best : k.frame > best)) best = k.frame;
      }
    }
  }
  return best;
}

/** Shift every keyframe by `delta` frames (used when a clip's start is trimmed, so keys stay at the same timeline/media moment). */
export function shiftAnimation(anim: ClipAnimation, delta: number): ClipAnimation {
  const tracks: Record<PropertyPath, KeyframeTrack> = {};
  for (const [path, t] of Object.entries(anim.tracks)) tracks[path] = { keyframes: t.keyframes.map((k) => ({ ...k, frame: k.frame + delta })) };
  return { tracks };
}

/**
 * Validates animation from untrusted data (project files): known paths only,
 * integer frames, finite values, valid easing, sorted + unique. Returns an
 * error string instead of throwing so the caller can report it with context.
 */
export function validateAnimation(raw: unknown, isKnownPath: (p: string) => boolean): { ok: true; animation: ClipAnimation } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || typeof (raw as { tracks?: unknown }).tracks !== "object" || (raw as { tracks: unknown }).tracks === null) {
    return { ok: false, error: "animation.tracks missing" };
  }
  const tracks: Record<PropertyPath, KeyframeTrack> = {};
  for (const [path, t] of Object.entries((raw as { tracks: Record<string, unknown> }).tracks)) {
    if (!isKnownPath(path)) return { ok: false, error: `unknown animated property "${path}"` };
    const ks = (t as { keyframes?: unknown })?.keyframes;
    if (!Array.isArray(ks) || ks.length === 0) return { ok: false, error: `track "${path}" has no keyframes` };
    const out: Keyframe[] = [];
    for (const k of ks as Record<string, unknown>[]) {
      const easing = normalizeEasing(k?.easing);
      if (typeof k?.id !== "string" || !Number.isInteger(k.frame) || typeof k.value !== "number" || !Number.isFinite(k.value) || !easing) {
        return { ok: false, error: `invalid keyframe in "${path}"` };
      }
      out.push({ id: k.id, frame: k.frame as number, value: k.value, easing });
    }
    const sorted = sortKeyframes(out);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].frame === sorted[i - 1].frame) return { ok: false, error: `duplicate keyframe frame in "${path}"` };
    tracks[path] = { keyframes: sorted };
  }
  return { ok: true, animation: { tracks } };
}
