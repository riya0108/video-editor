import { timelineDurationFrames, type TimelineModel } from "../timeline/model";
import { checkRenderSettings, DEFAULT_AUDIO, defaultVideoBitrate, type AudioOutputSettings, type RenderSettings } from "./settings";
import { audioSegments } from "../audio/engine-core";
import { clipTimelineEnd } from "../timeline/clip";
import { transitionWindow } from "../transitions/model";

/**
 * RENDER PLAN (RENDER_ENGINE_ARCHITECTURE.md §3) — pure and deterministic. Decides, before a single pixel is drawn,
 * exactly how many frames the output has, what timeline instant each one shows, how long the audio is, and which
 * frames are validated after encoding.
 *
 * TIME MAPPING. Output frame k covers [k/fps, (k+1)/fps). It shows the timeline at T_k = k/fps, i.e. timeline frame
 *   f_k = k x projectFps / fps            (exact rational; integer whenever the rates match)
 * so clip activity, keyframes, transitions and captions are evaluated at the frame's START — the convention preview
 * uses at every integer frame. MEDIA is sampled at the CENTRE of the output frame's interval: the frame provider
 * seeks to (sourceFrame + 0.5) / projectFps, so each media source frame is shifted by
 *   mediaFrameOffset = 0.5 x projectFps / fps - 0.5
 * (0 when the rates match: final == preview frame for frame). A seek therefore never lands on a source frame
 * boundary, whatever the rate pair (24 -> 60, 30 -> 25, 60 -> 24 ...).
 */

export interface FrameStep {
  /** Output frame index. */
  index: number;
  /** Seconds. */
  timestamp: number;
  duration: number;
  /** Timeline frame (project frames; fractional when the output rate differs). */
  timelineFrame: number;
}

export interface RenderPlan {
  settings: Required<Omit<RenderSettings, "audio">> & { audio: AudioOutputSettings | null };
  projectFps: number;
  renderScale: number;
  /** Timeline end, project frames. */
  timelineFrames: number;
  frameCount: number;
  /** Exactly frameCount / fps. Audio is rendered to this length too. */
  durationSec: number;
  mediaFrameOffset: number;
  audioSamples: number;
  /** Output frames decoded back and compared to the rendered reference after encoding. */
  checkpoints: number[];
}

export class RenderPlanError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(" "));
    this.name = "RenderPlanError";
  }
}

export function timelineFrameAt(index: number, projectFps: number, fps: number): number {
  // Integer numerator / integer denominator: exact for every supported pair (no accumulated float drift).
  return (index * projectFps) / fps;
}

export function frameStep(plan: Pick<RenderPlan, "projectFps" | "settings">, index: number): FrameStep {
  const fps = plan.settings.fps;
  return { index, timestamp: index / fps, duration: 1 / fps, timelineFrame: timelineFrameAt(index, plan.projectFps, fps) };
}

export function hasAudibleAudio(timeline: TimelineModel): boolean {
  const end = timelineDurationFrames(timeline) / timeline.frameRate;
  return end > 0 && audioSegments(timeline, { fromSec: 0, toSec: end, hasAudio: () => true }).length > 0;
}

export function buildRenderPlan(timeline: TimelineModel, settings: RenderSettings): RenderPlan {
  const check = checkRenderSettings(timeline, settings);
  if (!check.ok) throw new RenderPlanError(check.errors);
  const timelineFrames = timelineDurationFrames(timeline);
  if (timelineFrames <= 0) throw new RenderPlanError(["The timeline is empty."]);
  const projectFps = timeline.frameRate;
  const fps = settings.fps;
  // Every timeline instant is covered: the last output frame starts before the timeline ends.
  const frameCount = Math.max(1, Math.ceil((timelineFrames * fps) / projectFps - 1e-9));
  const durationSec = frameCount / fps;
  const audio = settings.audio === null ? null : hasAudibleAudio(timeline) ? (settings.audio ?? DEFAULT_AUDIO) : null;
  const keyframeIntervalSec = settings.keyframeIntervalSec ?? 2;
  return {
    settings: {
      width: settings.width,
      height: settings.height,
      fps,
      videoBitrate: settings.videoBitrate ?? defaultVideoBitrate(settings.width, settings.height, fps),
      keyframeIntervalSec,
      audio,
    },
    projectFps,
    renderScale: check.renderScale,
    timelineFrames,
    frameCount,
    durationSec,
    mediaFrameOffset: 0.5 * (projectFps / fps) - 0.5,
    audioSamples: audio ? Math.round(durationSec * audio.sampleRate) : 0,
    checkpoints: chooseCheckpoints(timeline, frameCount, projectFps, fps),
  };
}

/**
 * Frames worth decoding back: first, last, evenly spaced ones, every transition's midpoint, and the frames where a
 * clip starts or ends (where an off-by-one in the time mapping would show). At most ~24, sorted, unique.
 */
export function chooseCheckpoints(timeline: TimelineModel, frameCount: number, projectFps: number, fps: number): number[] {
  const out = new Set<number>([0, frameCount - 1]);
  const toOut = (f: number) => Math.min(frameCount - 1, Math.max(0, Math.ceil((f * fps) / projectFps - 1e-9)));
  for (let i = 1; i < 8; i++) out.add(Math.round(((frameCount - 1) * i) / 8));
  const edges: number[] = [];
  for (const c of Object.values(timeline.clips)) if (c.content.kind !== "audio") edges.push(c.timelineStart, clipTimelineEnd(c));
  for (const e of [...new Set(edges)].sort((a, b) => a - b).slice(0, 8)) {
    out.add(toOut(e));
    out.add(toOut(e) - 1);
  }
  for (const t of Object.values(timeline.transitions ?? {})) {
    const w = t.enabled ? transitionWindow(timeline, t) : null;
    if (w) out.add(toOut((w.start + w.end) / 2));
  }
  return [...out].filter((k) => k >= 0 && k < frameCount).sort((a, b) => a - b).slice(0, 24);
}
