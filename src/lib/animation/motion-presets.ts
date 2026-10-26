import { clipTimelineEnd } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { addKeyframe, removeKeyframe } from "../timeline/operations";
import { TimelineEditError } from "../timeline/errors";
import type { EasingSpec } from "./easing";
import { valueAt } from "./properties";

/**
 * MOTION PRESETS — one-click In / Out / Loop animations for any visual layer (text, stickers, images, video).
 *
 * A preset is not a new kind of data: it writes ordinary keyframes (KEYFRAME_ENGINE_ARCHITECTURE.md) through the
 * same pure operations the keyframe UI uses, so it previews, exports, saves, and can be hand-tweaked afterwards
 * exactly like keyframes set by hand. Each slot owns a WINDOW of the clip:
 *
 *   In   [0, inLen]                    — from an offset state to the layer's resting values
 *   Loop (inLen, end - outLen)         — oscillates around the resting values
 *   Out  [end - outLen, end]           — from the resting values to an offset state
 *
 * Applying a preset first clears every motion keyframe inside its own window (so re-applying, or choosing "None",
 * replaces rather than stacks) and leaves keyframes outside it alone — In, Loop and Out combine freely.
 */

export type MotionSlot = "in" | "out" | "loop";

/** Property paths a preset may animate; clearing a slot clears these inside its window. */
const PATHS = {
  x: "visual.transform.x",
  y: "visual.transform.y",
  sx: "visual.transform.scaleX",
  sy: "visual.transform.scaleY",
  rot: "visual.transform.rotation",
  op: "visual.opacity",
  cropR: "visual.crop.right",
  cropL: "visual.crop.left",
} as const;
type Key = keyof typeof PATHS;
const MOTION_PATHS = Object.values(PATHS);

/** Resting values of the animated properties, in composition units. */
type Base = Record<Key, number>;
interface Ctx {
  base: Base;
  w: number;
  h: number;
}

/** One property's keyframes in a slot: t is 0..1 across the slot's window. */
type Curve = { key: Key; keys: { t: number; v: (c: Ctx) => number; easing?: EasingSpec }[] };

export interface MotionPreset {
  id: string;
  label: string;
  slot: MotionSlot;
  curves: Curve[];
}

const OUT: EasingSpec = { type: "ease-out" };
const IN: EasingSpec = { type: "ease-in" };
const IO: EasingSpec = { type: "ease-in-out" };
const BACK: EasingSpec = { type: "cubic-bezier", x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

const b = (k: Key) => (c: Ctx) => c.base[k];
const scaled = (k: Key, f: number) => (c: Ctx) => c.base[k] * f;
const fadeIn: Curve = { key: "op", keys: [{ t: 0, v: () => 0, easing: OUT }, { t: 0.7, v: b("op") }] };
const fadeOut: Curve = { key: "op", keys: [{ t: 0.3, v: b("op"), easing: IN }, { t: 1, v: () => 0 }] };
/** Scale keys expressed as factors of the resting scale (each axis keeps its own resting value). */
function scaleCurves(factors: { t: number; f: number; easing?: EasingSpec }[]): Curve[] {
  return [
    { key: "sx", keys: factors.map(({ t, f, easing }) => ({ t, v: scaled("sx", f), easing })) },
    { key: "sy", keys: factors.map(({ t, f, easing }) => ({ t, v: scaled("sy", f), easing })) },
  ];
}

export const MOTION_PRESETS: readonly MotionPreset[] = [
  // ---- In ----
  { id: "fade-in", label: "Fade", slot: "in", curves: [{ key: "op", keys: [{ t: 0, v: () => 0, easing: OUT }, { t: 1, v: b("op") }] }] },
  { id: "rise-in", label: "Rise", slot: "in", curves: [{ key: "y", keys: [{ t: 0, v: (c) => c.base.y + c.h * 0.06, easing: OUT }, { t: 1, v: b("y") }] }, fadeIn] },
  { id: "drop-in", label: "Drop", slot: "in", curves: [{ key: "y", keys: [{ t: 0, v: (c) => c.base.y - c.h * 0.08, easing: BACK }, { t: 1, v: b("y") }] }, fadeIn] },
  { id: "slide-left-in", label: "Slide left", slot: "in", curves: [{ key: "x", keys: [{ t: 0, v: (c) => c.base.x + c.w * 0.12, easing: OUT }, { t: 1, v: b("x") }] }, fadeIn] },
  { id: "slide-right-in", label: "Slide right", slot: "in", curves: [{ key: "x", keys: [{ t: 0, v: (c) => c.base.x - c.w * 0.12, easing: OUT }, { t: 1, v: b("x") }] }, fadeIn] },
  { id: "pop-in", label: "Pop", slot: "in", curves: [...scaleCurves([{ t: 0, f: 0.4, easing: BACK }, { t: 1, f: 1 }]), { key: "op", keys: [{ t: 0, v: () => 0, easing: OUT }, { t: 0.4, v: b("op") }] }] },
  { id: "zoom-in", label: "Zoom", slot: "in", curves: [...scaleCurves([{ t: 0, f: 1.6, easing: OUT }, { t: 1, f: 1 }]), fadeIn] },
  { id: "spin-in", label: "Spin", slot: "in", curves: [{ key: "rot", keys: [{ t: 0, v: (c) => c.base.rot - 180, easing: OUT }, { t: 1, v: b("rot") }] }, ...scaleCurves([{ t: 0, f: 0.3, easing: OUT }, { t: 1, f: 1 }]), fadeIn] },
  { id: "wipe-in", label: "Wipe", slot: "in", curves: [{ key: "cropR", keys: [{ t: 0, v: () => 1, easing: IO }, { t: 1, v: b("cropR") }] }] },
  // ---- Out ----
  { id: "fade-out", label: "Fade", slot: "out", curves: [{ key: "op", keys: [{ t: 0, v: b("op"), easing: IN }, { t: 1, v: () => 0 }] }] },
  { id: "sink-out", label: "Sink", slot: "out", curves: [{ key: "y", keys: [{ t: 0, v: b("y"), easing: IN }, { t: 1, v: (c) => c.base.y + c.h * 0.06 }] }, fadeOut] },
  { id: "rise-out", label: "Rise", slot: "out", curves: [{ key: "y", keys: [{ t: 0, v: b("y"), easing: IN }, { t: 1, v: (c) => c.base.y - c.h * 0.06 }] }, fadeOut] },
  { id: "slide-left-out", label: "Slide left", slot: "out", curves: [{ key: "x", keys: [{ t: 0, v: b("x"), easing: IN }, { t: 1, v: (c) => c.base.x - c.w * 0.12 }] }, fadeOut] },
  { id: "pop-out", label: "Pop", slot: "out", curves: [...scaleCurves([{ t: 0, f: 1, easing: OUT }, { t: 0.35, f: 1.12, easing: IN }, { t: 1, f: 0.2 }]), { key: "op", keys: [{ t: 0.5, v: b("op"), easing: IN }, { t: 1, v: () => 0 }] }] },
  { id: "zoom-out", label: "Zoom", slot: "out", curves: [...scaleCurves([{ t: 0, f: 1, easing: IN }, { t: 1, f: 1.6 }]), fadeOut] },
  { id: "wipe-out", label: "Wipe", slot: "out", curves: [{ key: "cropL", keys: [{ t: 0, v: b("cropL"), easing: IO }, { t: 1, v: () => 1 }] }] },
  // ---- Loop ---- (t spans one period; the period repeats across the loop window)
  { id: "pulse", label: "Pulse", slot: "loop", curves: scaleCurves([{ t: 0, f: 1, easing: IO }, { t: 0.5, f: 1.07, easing: IO }, { t: 1, f: 1 }]) },
  { id: "float", label: "Float", slot: "loop", curves: [{ key: "y", keys: [{ t: 0, v: b("y"), easing: IO }, { t: 0.5, v: (c) => c.base.y - c.h * 0.015, easing: IO }, { t: 1, v: b("y") }] }] },
  { id: "wiggle", label: "Wiggle", slot: "loop", curves: [{ key: "rot", keys: [{ t: 0, v: b("rot"), easing: IO }, { t: 0.25, v: (c) => c.base.rot + 4, easing: IO }, { t: 0.75, v: (c) => c.base.rot - 4, easing: IO }, { t: 1, v: b("rot") }] }] },
  { id: "blink", label: "Blink", slot: "loop", curves: [{ key: "op", keys: [{ t: 0, v: b("op"), easing: IO }, { t: 0.5, v: scaled("op", 0.25), easing: IO }, { t: 1, v: b("op") }] }] },
];

export function getMotionPreset(id: string): MotionPreset | undefined {
  return MOTION_PRESETS.find((p) => p.id === id);
}

/** Loop period in seconds per preset. */
const LOOP_PERIOD_SEC: Record<string, number> = { pulse: 1, float: 2, wiggle: 0.5, blink: 1 };

/** Frame windows of each slot for a clip of `length` frames (local frames 0..length-1). */
export function motionWindows(length: number, fps: number): Record<MotionSlot, [number, number]> {
  const last = Math.max(0, length - 1);
  const len = Math.max(1, Math.min(Math.round(fps * 0.5), Math.floor(last / 3)));
  return { in: [0, Math.min(len, last)], out: [Math.max(0, last - len), last], loop: [Math.min(len + 1, last), Math.max(0, last - len - 1)] };
}

/**
 * Applies a preset (or clears the slot when `presetId` is null) to a clip. Pure; one undo step via engine.transact.
 * Throws TimelineEditError on locked tracks, non-visual clips, or an unknown preset.
 */
export function applyMotionPreset(timeline: TimelineModel, clipId: string, slot: MotionSlot, presetId: string | null): TimelineModel {
  const clip = timeline.clips[clipId];
  if (!clip) throw new TimelineEditError("clip-not-found", `No clip "${clipId}".`);
  if (timeline.tracks[clip.trackId]?.locked) throw new TimelineEditError("track-locked", "This layer's track is locked.");
  if (clip.content.kind === "audio") throw new TimelineEditError("invalid-keyframe", "Audio clips have no picture to animate.");
  const preset = presetId ? getMotionPreset(presetId) : null;
  if (presetId && (!preset || preset.slot !== slot)) throw new TimelineEditError("out-of-range", `Unknown ${slot} animation "${presetId}".`);
  const length = clipTimelineEnd(clip) - clip.timelineStart;
  const win = motionWindows(length, timeline.frameRate);
  const [w0, w1] = win[slot];
  const comp = timeline.composition;

  // Resting values, read BEFORE clearing: just outside this slot's window, so an earlier preset's offsets never leak in.
  const restFrame = slot === "in" ? win.in[1] : slot === "out" ? win.out[0] : win.loop[0];
  const base = Object.fromEntries((Object.keys(PATHS) as Key[]).map((k) => [k, valueAt(clip, PATHS[k], restFrame, comp)])) as Base;

  let tl = timeline;
  // Clear this window. Removal order leaves the key nearest the resting side for last, so a property whose LAST key goes
  // becomes static at its resting value (removeKeyframe's rule), not at an offset.
  for (const path of MOTION_PATHS) {
    const keys = tl.clips[clipId].animation?.tracks[path]?.keyframes.filter((k) => k.frame >= w0 && k.frame <= w1) ?? [];
    const ordered = [...keys].sort((a, b2) => (slot === "out" ? b2.frame - a.frame : a.frame - b2.frame));
    for (const k of ordered) tl = removeKeyframe(tl, clipId, path, k.id);
  }
  if (!preset || w1 <= w0) return tl;

  const ctx: Ctx = { base, w: comp.width, h: comp.height };
  const at = (local: number) => clip.timelineStart + local;
  if (slot === "loop") {
    const period = Math.max(4, Math.round((LOOP_PERIOD_SEC[preset.id] ?? 1) * timeline.frameRate));
    const cycles = Math.floor((w1 - w0) / period);
    if (cycles < 1) return tl;
    for (const curve of preset.curves) {
      for (let cyc = 0; cyc < cycles; cyc++) {
        for (const k of curve.keys) {
          if (cyc > 0 && k.t === 0) continue; // shared with the previous cycle's last key
          tl = addKeyframe(tl, clipId, PATHS[curve.key], at(w0 + Math.round((cyc + k.t) * period)), k.v(ctx), k.easing);
        }
      }
    }
    return tl;
  }
  for (const curve of preset.curves) {
    for (const k of curve.keys) tl = addKeyframe(tl, clipId, PATHS[curve.key], at(w0 + Math.round(k.t * (w1 - w0))), k.v(ctx), k.easing);
  }
  return tl;
}

/** Whether each slot currently holds motion keyframes (strictly inside its window, so shared boundary keys don't count). */
export function activeMotionSlots(timeline: TimelineModel, clipId: string): Record<MotionSlot, boolean> {
  const clip = timeline.clips[clipId];
  const none = { in: false, out: false, loop: false };
  if (!clip?.animation) return none;
  const win = motionWindows(clipTimelineEnd(clip) - clip.timelineStart, timeline.frameRate);
  const has = (lo: number, hi: number) => MOTION_PATHS.some((p) => clip.animation!.tracks[p]?.keyframes.some((k) => k.frame >= lo && k.frame <= hi));
  return { in: has(win.in[0], win.in[1] - 1), out: has(win.out[0] + 1, win.out[1]), loop: has(win.loop[0] + 1, win.loop[1] - 1) };
}
