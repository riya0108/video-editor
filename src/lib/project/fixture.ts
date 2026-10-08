import type { TimelineModel } from "../timeline/model";
import { addGuide, setCaptionWords, setClipAudio, setClipVisual } from "../timeline/operations";
import { buildProbeProject } from "../render/probe-project";
import { presetProfile } from "../export/presets";
import { deserializeTimeline, serializeTimeline } from "../timeline/serialize";
import type { ExportSettingsState } from "./document";

/**
 * COMPLEX PROJECT FIXTURE (PROJECT_RECOVERY_TEST_REPORT.md) — the Phase 15 probe project (video with a cut and a
 * cross-dissolve, 50 %-alpha image, effect, ellipse mask, keyframes, text, caption, audio) plus everything else a
 * project must preserve: a crop, a matte that points at GENERATED media, caption word timings, audio fades/volume,
 * guides, AI results the user has curated, and modified export settings. Pure — used by Node tests and the browser.
 */

export const FIXTURE_MATTE_ID = "probe-matte";

export function buildComplexProject(width = 1920, height = 1080): { timeline: TimelineModel; aiResults: unknown; exportSettings: ExportSettingsState; ids: Record<string, string> } {
  const { timeline: base, ids } = buildProbeProject(width, height);
  let tl = base;
  tl = setClipVisual(tl, ids.logoClip, { crop: { top: 0.1, left: 0.05, right: 0.15, bottom: 0.2 }, rotation: 7, blendMode: "screen" } as never);
  tl = setClipVisual(tl, ids.videoB, { matte: { sourceId: FIXTURE_MATTE_ID, invert: false, channel: "alpha", decontaminate: true } });
  tl = setCaptionWords(tl, ids.captionClip, [
    { text: "CAPTION", start: 0, end: 0.6 },
    { text: "TEST", start: 0.6, end: 1.4 },
  ]);
  tl = setClipAudio(tl, ids.toneClip, { volume: 0.8, fadeInFrames: 8, fadeOutFrames: 15 });
  tl = addGuide(tl, "x", width / 3).timeline;
  tl = addGuide(tl, "y", height * 0.9).timeline;
  const aiResults = {
    format: "clipbench-ai-results",
    version: 1,
    results: [
      {
        id: "ai-silence-1",
        feature: "silence-detection",
        providerId: "rms-gate",
        providerKind: "signal-processing",
        target: { clipId: ids.toneClip, sourceId: "probe-tone", sourceStart: 0, sourceEnd: 3.5 },
        createdAt: 1_759_900_000_000,
        items: [
          { id: "s1", kind: "silence", start: 0.1, end: 0.9, levelDb: -48.2, accepted: true, confidence: { value: 0.91, basis: "margin" } },
          { id: "s2", kind: "silence", start: 1.2, end: 2.4, levelDb: -45.0, accepted: false, edited: true, confidence: { value: 0.77, basis: "margin" } },
        ],
        warnings: ["Room tone under -50 dB treated as silence."],
        metrics: { durationMs: 41, audioSeconds: 3.5 },
        params: { thresholdDb: -40, minDurationSec: 0.3 },
      },
    ],
  };
  // As the editor holds it after any load: every style/setting explicit (the loader's normalization is idempotent).
  tl = deserializeTimeline(serializeTimeline(tl));
  const exportSettings: ExportSettingsState = { presetId: "youtube", profile: { ...presetProfile("youtube", tl), fps: 60, videoBitrate: 12e6, audioBitrate: 256_000 }, modified: true };
  return { timeline: tl, aiResults, exportSettings, ids };
}
