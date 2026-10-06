import { clipTimelineEnd, type Clip } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { easingFn, normalizeEasing, type EasingSpec } from "../animation/easing";
import { getTransitionDefinition, isTransitionType, type TransitionDirection, type TransitionParams } from "./registry";

/**
 * TRANSITION MODEL (TRANSITIONS_ARCHITECTURE.md §2). A transition belongs to
 * an EDIT POINT on a track, not to a clip: between two adjacent clips
 * (from -> to), or at a single clip's start (from = null: transition in) or
 * end (to = null: transition out). Stored in `timeline.transitions`.
 *
 * Tracks stay non-overlapping. Inside the transition window the outgoing clip
 * continues past its out point (and the incoming clip starts before its in
 * point) using source handles when the source has them, otherwise holding the
 * edge frame — so a transition never changes clip positions or the timeline
 * duration, and deleting it restores the plain cut exactly.
 */

/** Where the window sits relative to the cut: centered on it, ending at it (inside the outgoing clip) or starting at it (inside the incoming clip). */
export type TransitionAlignment = "center" | "end" | "start";

export interface Transition {
  id: string;
  type: string;
  trackId: string;
  fromClipId: string | null;
  toClipId: string | null;
  /** Frames, >= 1. Clamped to what the clips can host (see maxTransitionDuration). */
  duration: number;
  alignment: TransitionAlignment;
  params: TransitionParams;
  direction?: TransitionDirection;
  easing: EasingSpec;
  enabled: boolean;
  metadata?: { label?: string; [k: string]: unknown };
}

export interface TransitionWindow {
  /** First frame of the window (inclusive). */
  start: number;
  /** End frame (exclusive). */
  end: number;
  /** The edit point (to.start / from.end for boundary transitions). */
  cut: number;
  from: Clip | null;
  to: Clip | null;
  /** Effective duration (stored duration clamped to the clips' room). */
  duration: number;
}

export function allTransitions(timeline: TimelineModel): Transition[] {
  return Object.values(timeline.transitions ?? {});
}

function clipOnTrack(timeline: TimelineModel, clipId: string | null, trackId: string): Clip | null | undefined {
  if (clipId === null) return null;
  const c = timeline.clips[clipId];
  return c && c.trackId === trackId ? c : undefined;
}

/** Frames of `d` that lie inside the outgoing / incoming clip. */
export function insidePortions(t: Pick<Transition, "fromClipId" | "toClipId" | "alignment">, d: number): { from: number; to: number } {
  if (t.fromClipId === null) return { from: 0, to: d };
  if (t.toClipId === null) return { from: d, to: 0 };
  if (t.alignment === "end") return { from: d, to: 0 };
  if (t.alignment === "start") return { from: 0, to: d };
  return { from: Math.floor(d / 2), to: Math.ceil(d / 2) };
}

/** The other transition sharing an edge of `clipId` (its start edge if `edge` = "start"). */
function transitionAtEdge(timeline: TimelineModel, clipId: string, edge: "start" | "end", excludeId?: string): Transition | undefined {
  return allTransitions(timeline).find((t) => t.id !== excludeId && (edge === "start" ? t.toClipId === clipId : t.fromClipId === clipId));
}

/**
 * Longest duration `t` can have: the part inside each clip must fit in what's
 * left of that clip after the transition on its OTHER edge (so a clip's
 * transition-in and transition-out never overlap). 0 if there's no room.
 */
export function maxTransitionDuration(timeline: TimelineModel, t: Transition): number {
  const room = (clipId: string | null, otherEdge: "start" | "end"): number => {
    if (clipId === null) return Infinity;
    const c = timeline.clips[clipId];
    if (!c) return 0;
    const dur = clipTimelineEnd(c) - c.timelineStart;
    const other = transitionAtEdge(timeline, clipId, otherEdge, t.id);
    if (!other) return dur;
    const used = insidePortions(other, other.duration);
    return Math.max(0, dur - (otherEdge === "start" ? used.to : used.from));
  };
  const rf = room(t.fromClipId, "start"); // the outgoing clip's other edge is its start
  const rt = room(t.toClipId, "end");
  if (t.fromClipId === null) return rt;
  if (t.toClipId === null) return rf;
  if (t.alignment === "end") return rf;
  if (t.alignment === "start") return rt;
  return Math.max(0, Math.min(2 * rf + 1, 2 * rt));
}

/**
 * Where `t` sits on the timeline right now, or null if it no longer applies
 * (a clip is gone / moved to another track / no longer adjacent, or there's
 * no room). The single validity check shared by ops, reconcile and resolve.
 */
export function transitionWindow(timeline: TimelineModel, t: Transition): TransitionWindow | null {
  const track = timeline.tracks[t.trackId];
  if (!track || track.kind === "audio") return null;
  const from = clipOnTrack(timeline, t.fromClipId, t.trackId);
  const to = clipOnTrack(timeline, t.toClipId, t.trackId);
  if (from === undefined || to === undefined || (from === null && to === null)) return null;
  if (from && to && clipTimelineEnd(from) !== to.timelineStart) return null;
  const d = Math.min(t.duration, maxTransitionDuration(timeline, t));
  if (!(d >= 1)) return null;
  const cut = to ? to.timelineStart : clipTimelineEnd(from!);
  const inside = insidePortions(t, d);
  const start = to === null ? cut - d : from === null ? cut : cut - inside.from;
  return { start, end: start + d, cut, from, to, duration: d };
}

/** Linear progress at `frame` inside the window: strictly between 0 and 1, so neither end frame is a pure copy of the frame just outside. */
export function linearProgress(window: Pick<TransitionWindow, "start" | "duration">, frame: number): number {
  return (frame - window.start + 1) / (window.duration + 1);
}

export interface ActiveTransition {
  transition: Transition;
  window: TransitionWindow;
  linear: number;
  /** Eased progress. */
  progress: number;
}

/** Transitions grouped by track (built once per resolved frame). */
export function transitionsByTrack(timeline: TimelineModel): Map<string, Transition[]> {
  const map = new Map<string, Transition[]>();
  for (const t of allTransitions(timeline)) {
    const list = map.get(t.trackId);
    if (list) list.push(t);
    else map.set(t.trackId, [t]);
  }
  return map;
}

/** The enabled transition on a track covering `frame` (windows on one track never overlap). */
export function activeTransitionAt(timeline: TimelineModel, candidates: readonly Transition[] | undefined, frame: number): ActiveTransition | null {
  if (!candidates) return null;
  for (const t of candidates) {
    if (!t.enabled) continue;
    const w = transitionWindow(timeline, t);
    if (!w || frame < w.start || frame >= w.end) continue;
    const linear = linearProgress(w, frame);
    return { transition: t, window: w, linear, progress: easingFn(t.easing)(linear) };
  }
  return null;
}

/** Stable numeric seed from a transition id (noise-based types). */
export function transitionSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h | 0;
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Complete, valid params for `type`: every defined param present (numbers clamped, colors hex), unknown keys dropped. */
export function normalizeTransitionParams(type: string, raw: unknown): TransitionParams {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: TransitionParams = {};
  for (const p of getTransitionDefinition(type)?.params ?? []) {
    const v = r[p.key];
    if (p.kind === "color") out[p.key] = typeof v === "string" && HEX.test(v) ? v.toLowerCase() : p.default;
    else out[p.key] = typeof v === "number" && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return out;
}

/** A direction the type supports, else its default (undefined for direction-less types). */
export function normalizeDirection(type: string, raw: unknown): TransitionDirection | undefined {
  const dirs = getTransitionDefinition(type)?.directions;
  if (!dirs) return undefined;
  return dirs.includes(raw as TransitionDirection) ? (raw as TransitionDirection) : dirs[0];
}

export const DEFAULT_TRANSITION_EASING: EasingSpec = { type: "ease-in-out" };

/** Validates one transition from untrusted data (shape only — placement is checked by transitionWindow). Null if unusable. */
export function normalizeTransition(raw: unknown): Transition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.trackId !== "string" || !isTransitionType(r.type)) return null;
  const from = r.fromClipId === null || r.fromClipId === undefined ? null : r.fromClipId;
  const to = r.toClipId === null || r.toClipId === undefined ? null : r.toClipId;
  if ((from !== null && typeof from !== "string") || (to !== null && typeof to !== "string") || (from === null && to === null)) return null;
  if (typeof r.duration !== "number" || !Number.isInteger(r.duration) || r.duration < 1) return null;
  const alignment: TransitionAlignment = from === null ? "start" : to === null ? "end" : r.alignment === "start" || r.alignment === "end" ? r.alignment : "center";
  const easing = r.easing === undefined ? DEFAULT_TRANSITION_EASING : normalizeEasing(r.easing);
  if (!easing) return null;
  const t: Transition = {
    id: r.id,
    type: r.type,
    trackId: r.trackId,
    fromClipId: from as string | null,
    toClipId: to as string | null,
    duration: r.duration,
    alignment,
    params: normalizeTransitionParams(r.type, r.params),
    easing,
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
  };
  const direction = normalizeDirection(r.type, r.direction);
  if (direction) t.direction = direction;
  if (typeof r.metadata === "object" && r.metadata !== null) t.metadata = r.metadata as Transition["metadata"];
  return t;
}

/** Human label for a transition's placement ("A → B", "In: B", "Out: A"). */
export function transitionKindLabel(t: Pick<Transition, "fromClipId" | "toClipId">): "between" | "in" | "out" {
  return t.fromClipId === null ? "in" : t.toClipId === null ? "out" : "between";
}
