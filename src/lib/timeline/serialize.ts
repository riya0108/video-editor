import { reserveIds } from "./id";
import { DEFAULT_COMPOSITION, validateCompositionSize, type Guide, type TimelineModel } from "./model";
import { applyVisualPatch, defaultClipVisual } from "./visual";
import { normalizeTextStyle } from "./text-style";
import { normalizeShapeSpec, normalizeSvgSpec } from "./shape-style";
import { clipTimelineEnd, hasVisual, isTrimmableContent, type Clip } from "./clip";
import type { Track } from "./track";

/**
 * SAVE / RELOAD. A project is plain JSON: the TimelineModel inside a small
 * versioned envelope. Only references and numbers are stored — source media
 * is never embedded (MediaSourceRef.sourceId is resolved by the media layer
 * on load), so saving can't alter or duplicate an asset.
 *
 * Deserialization VALIDATES rather than trusts: structural consistency
 * (track<->clip links, kinds, non-overlap), every visual re-run through
 * applyVisualPatch's validation, composition size, guides. Anything wrong is
 * a ProjectFormatError — a corrupt or hand-edited file never loads as a
 * half-valid project. Older files are upgraded: v1 (before guides/
 * composition) gets defaults; v2 text styles (italic/align, implicit
 * background/stroke) migrate to the v3 TextStyle via normalizeTextStyle; v3
 * shapes (fill/stroke as optional color strings) migrate to v4 ShapeSpec.
 *
 * Loading also reserves every loaded id so new ids can't collide (see
 * id.ts reserveIds).
 */

export const PROJECT_FORMAT = "clipbench-timeline";
export const PROJECT_VERSION = 4;

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

export function serializeTimeline(timeline: TimelineModel): string {
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, timeline });
}

function fail(msg: string): never {
  throw new ProjectFormatError(msg);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function deserializeTimeline(json: string): TimelineModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("Not valid JSON.");
  }
  if (!isObj(parsed) || parsed.format !== PROJECT_FORMAT) fail(`Not a ${PROJECT_FORMAT} file.`);
  if (!isInt(parsed.version) || parsed.version < 1 || parsed.version > PROJECT_VERSION) {
    fail(`Unsupported project version ${String(parsed.version)} (this build reads 1-${PROJECT_VERSION}).`);
  }
  const raw = parsed.timeline;
  if (!isObj(raw)) fail("Missing timeline.");
  if (typeof raw.id !== "string") fail("timeline.id must be a string.");
  if (typeof raw.frameRate !== "number" || !(raw.frameRate > 0)) fail("timeline.frameRate must be > 0.");

  // v1 -> v2: composition + guides didn't exist yet.
  const composition = { ...DEFAULT_COMPOSITION, ...(isObj(raw.composition) ? raw.composition : {}) };
  try {
    validateCompositionSize(composition.width, composition.height);
  } catch (e) {
    fail((e as Error).message);
  }
  if (typeof composition.background !== "string") fail("composition.background must be a string.");

  const guides: Guide[] = [];
  for (const g of Array.isArray(raw.guides) ? raw.guides : []) {
    if (!isObj(g) || typeof g.id !== "string" || (g.axis !== "x" && g.axis !== "y") || typeof g.position !== "number" || !Number.isFinite(g.position)) fail("Invalid guide.");
    guides.push({ id: g.id, axis: g.axis, position: g.position });
  }

  if (!Array.isArray(raw.trackIds) || !isObj(raw.tracks) || !isObj(raw.clips)) fail("timeline.trackIds/tracks/clips missing.");
  const tracks = raw.tracks as Record<string, Track>;
  const clips = raw.clips as Record<string, Clip>;
  const seenClips = new Set<string>();

  for (const trackId of raw.trackIds as unknown[]) {
    if (typeof trackId !== "string" || !isObj(tracks[trackId])) fail(`trackIds references missing track "${String(trackId)}".`);
    const t = tracks[trackId];
    if (t.id !== trackId || !Array.isArray(t.clipIds)) fail(`Track "${trackId}" is malformed.`);
    let prevEnd = -Infinity;
    for (const clipId of t.clipIds) {
      const c = clips[clipId];
      if (!isObj(c) || c.id !== clipId || c.trackId !== trackId) fail(`Track "${trackId}" references missing/mismatched clip "${clipId}".`);
      if (seenClips.has(clipId)) fail(`Clip "${clipId}" is on more than one track.`);
      seenClips.add(clipId);
      if (!isObj(c.content) || c.content.kind !== t.kind) fail(`Clip "${clipId}" kind doesn't match track "${trackId}".`);
      if (!isInt(c.timelineStart) || c.timelineStart < 0) fail(`Clip "${clipId}" has an invalid timelineStart.`);
      if (isTrimmableContent(c.content)) {
        if (!isInt(c.content.sourceInFrame) || !isInt(c.content.sourceOutFrame) || c.content.sourceInFrame < 0 || c.content.sourceOutFrame <= c.content.sourceInFrame) fail(`Clip "${clipId}" has invalid in/out points.`);
        if (!isObj(c.content.source) || typeof c.content.source.sourceId !== "string") fail(`Clip "${clipId}" has no source reference.`);
      } else if (!isInt(c.content.durationFrames) || c.content.durationFrames < 1) fail(`Clip "${clipId}" has an invalid duration.`);
      if (c.content.kind === "text") {
        if (typeof c.content.text !== "string") fail(`Text clip "${clipId}" has no text.`);
        // v2 -> v3: legacy style names (italic/align/...) migrate; any invalid value is normalized rather than trusted.
        c.content.textStyle = normalizeTextStyle(c.content.textStyle);
      }
      if (c.content.kind === "graphic") {
        // v3 -> v4: shapes migrate (fill/stroke color strings -> toggle + color) and are normalized; embedded SVG must still be valid.
        if (c.content.shape !== undefined) {
          const raw = { ...(c.content.shape as unknown as Record<string, unknown>) };
          // Pre-v4 files: an absent fill/stroke meant "off" (they were optional color strings). Only safe to apply here, where the file's version is known.
          if ((parsed as { version: number }).version < 4) {
            if (!("fill" in raw)) raw.fill = false;
            if (!("stroke" in raw)) raw.stroke = false;
          }
          c.content.shape = normalizeShapeSpec(raw);
        }
        if (c.content.svg !== undefined) {
          const svg = normalizeSvgSpec(c.content.svg);
          if (!svg) fail(`Graphic clip "${clipId}" has an invalid embedded SVG.`);
          c.content.svg = svg;
        }
        if (!c.content.shape && !c.content.svg && !c.content.source) fail(`Graphic clip "${clipId}" has no shape, SVG or source.`);
      }
      if (c.timelineStart < prevEnd) fail(`Clips overlap on track "${trackId}".`);
      prevEnd = clipTimelineEnd(c);
      if (c.visual !== undefined) {
        if (!hasVisual(c.content.kind)) fail(`Audio clip "${clipId}" can't have a visual.`);
        // Re-validate through the same code path an edit takes; also fills any field a future/older writer omitted.
        try {
          c.visual = applyVisualPatch(defaultClipVisual(composition.width, composition.height), c.visual);
        } catch (e) {
          fail(`Clip "${clipId}" has an invalid visual: ${(e as Error).message}`);
        }
      }
    }
  }
  if (seenClips.size !== Object.keys(clips).length) fail("Some clips aren't on any track.");
  if (Object.keys(tracks).length !== (raw.trackIds as unknown[]).length) fail("Some tracks aren't in trackIds.");

  const timeline: TimelineModel = {
    id: raw.id,
    frameRate: raw.frameRate,
    composition,
    guides,
    trackIds: raw.trackIds as string[],
    tracks,
    clips,
  };
  reserveIds([timeline.id, ...timeline.trackIds, ...Object.keys(clips), ...guides.map((g) => g.id)]);
  return timeline;
}
