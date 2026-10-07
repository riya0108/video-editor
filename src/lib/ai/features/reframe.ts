import { AIError, throwIfAborted } from "../errors";
import { sampleTimes } from "../media";
import { itemId, type AIProvider, type Availability } from "../provider";
import { conf, type ReframeItem, type ReframeKey } from "../types";
import type { DetectorBackend } from "./detection";

/**
 * AUTO REFRAMING — real detection models + a deterministic camera path. For a target aspect (e.g. 9:16 from a
 * 16:9 source) it finds the subject in sampled frames — largest FACE (BlazeFace), else largest PERSON
 * (EfficientDet), else the frame centre — and computes where a crop window of that aspect should sit:
 *
 *   gaps (no subject) hold the last known position -> dead zone (ignore moves under 8% of the crop) ->
 *   exponential smoothing -> speed limit (max 35% of the crop width per second) -> clamp inside the frame.
 *
 * So the virtual camera follows the subject calmly instead of jittering with every detection. Applying it keys the
 * clip's position (and sets a cover scale) — the source pixels are untouched and every key stays editable.
 * Confidence = fraction of samples where a subject was actually found.
 */

export interface ReframeParams {
  /** Target width / height. Default 9/16. */
  aspect?: number;
  samplesPerSecond?: number;
}

/** The largest window of `target` aspect inside a source of `src` aspect, as fractions of the source. */
export function cropSize(srcAspect: number, target: number): { cropW: number; cropH: number } {
  return srcAspect >= target ? { cropW: target / srcAspect, cropH: 1 } : { cropW: 1, cropH: srcAspect / target };
}

export function computeReframePath(samples: { time: number; subject: { cx: number; cy: number } | null }[], crop: { cropW: number; cropH: number }, opts: { deadZone?: number; smoothing?: number; maxSpeed?: number } = {}): ReframeKey[] {
  const dead = (opts.deadZone ?? 0.08) * crop.cropW;
  const alpha = opts.smoothing ?? 0.35;
  const maxSpeed = (opts.maxSpeed ?? 0.35) * crop.cropW;
  const clampX = (x: number) => Math.min(1 - crop.cropW / 2, Math.max(crop.cropW / 2, x));
  const clampY = (y: number) => Math.min(1 - crop.cropH / 2, Math.max(crop.cropH / 2, y));
  // Hold the last known subject through gaps; before the first detection use the first one (or centre).
  const firstSeen = samples.find((s) => s.subject)?.subject ?? { cx: 0.5, cy: 0.5 };
  let target = firstSeen;
  let x = clampX(firstSeen.cx);
  let y = clampY(firstSeen.cy);
  const keys: ReframeKey[] = [];
  samples.forEach((s, i) => {
    if (s.subject) target = s.subject;
    const dt = i === 0 ? 0 : s.time - samples[i - 1].time;
    let tx = clampX(target.cx);
    let ty = clampY(target.cy);
    if (Math.abs(tx - x) < dead) tx = x;
    if (Math.abs(ty - y) < dead * (crop.cropH / crop.cropW)) ty = y;
    let nx = x + (tx - x) * alpha;
    let ny = y + (ty - y) * alpha;
    if (i > 0) {
      const lim = maxSpeed * dt;
      nx = x + Math.max(-lim, Math.min(lim, nx - x));
      ny = y + Math.max(-lim, Math.min(lim, ny - y));
    }
    x = clampX(nx);
    y = clampY(ny);
    keys.push({ time: s.time, cx: +x.toFixed(4), cy: +y.toFixed(4) });
  });
  return keys;
}

export function createReframeProvider(loadFace: () => Promise<DetectorBackend>, loadObject: () => Promise<DetectorBackend>, available: () => Availability): AIProvider<ReframeParams> {
  return {
    id: "reframe.subject-follow",
    feature: "auto-reframe",
    label: "Auto reframe",
    kind: "ml-model",
    model: { name: "MediaPipe BlazeFace + EfficientDet-Lite0 (subject), smoothed camera path", source: "/models/", license: "Apache-2.0" },
    description: "Crops to a new aspect ratio (e.g. 9:16) and follows the main face or person with a smooth virtual camera. Keys the clip's position; nothing is rendered destructively.",
    needs: { video: true },
    availability: available,
    async run(req, ctx) {
      const media = req.media;
      if (!media.hasVideo) throw new AIError("media-unavailable", "This clip has no picture.");
      const aspect = req.params.aspect ?? 9 / 16;
      if (!(aspect > 0)) throw new AIError("invalid-input", "Invalid target aspect.");
      const srcAspect = media.width / media.height;
      const crop = cropSize(srcAspect, aspect);
      ctx.progress(0.02, "Loading face model");
      let face: DetectorBackend;
      try {
        face = await loadFace();
      } catch (e) {
        throw new AIError("model-load-failed", `Face model failed to load: ${(e as Error).message}`, e);
      }
      const times = media.still ? [media.sourceStart] : sampleTimes(media.sourceStart, media.sourceEnd, req.params.samplesPerSecond ?? 4, 400);
      const frames = [];
      const subjects: ({ cx: number; cy: number } | null)[] = [];
      for (let k = 0; k < times.length; k++) {
        throwIfAborted(ctx.signal);
        const f = await media.frameAt(times[k], 640);
        frames.push(f);
        const faces = (await face.detect(f)).filter((d) => d.score >= 0.5);
        const big = faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
        // Frame the face slightly below centre (headroom): aim a little lower than the face centre.
        subjects.push(big ? { cx: big.box.x + big.box.w / 2, cy: Math.min(1, big.box.y + big.box.h * 0.9) } : null);
        ctx.progress(0.05 + (0.6 * (k + 1)) / times.length, "Finding faces");
      }
      let subject: ReframeItem["subject"] = "face";
      const faceHits = subjects.filter(Boolean).length;
      if (faceHits < times.length * 0.5) {
        ctx.progress(0.66, "Loading object model");
        try {
          const obj = await loadObject();
          const persons: ({ cx: number; cy: number } | null)[] = [];
          for (let k = 0; k < frames.length; k++) {
            throwIfAborted(ctx.signal);
            const ps = (await obj.detect(frames[k])).filter((d) => d.label === "person" && d.score >= 0.4);
            const big = ps.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
            persons.push(big ? { cx: big.box.x + big.box.w / 2, cy: big.box.y + big.box.h * 0.35 } : null);
            ctx.progress(0.66 + (0.3 * (k + 1)) / frames.length, "Finding people");
          }
          if (persons.filter(Boolean).length > faceHits) {
            subjects.splice(0, subjects.length, ...persons);
            subject = "person";
          }
        } catch {
          /* object model unavailable: keep the face result (possibly empty) */
        }
      }
      const hits = subjects.filter(Boolean).length;
      if (hits === 0) subject = "center";
      const keys = computeReframePath(
        times.map((t, i) => ({ time: t, subject: subjects[i] })),
        crop,
      );
      const item: ReframeItem = { kind: "reframe", id: itemId("reframe"), accepted: true, aspect, cropW: +crop.cropW.toFixed(4), cropH: +crop.cropH.toFixed(4), keys, subject, confidence: conf(hits / times.length, "agreement") };
      const warnings = hits === 0 ? ["No face or person was found — the crop stays centred."] : hits < times.length * 0.6 ? [`The subject was found in only ${hits} of ${times.length} samples; the camera holds its last position in between.`] : [];
      return { items: [item], warnings, metrics: { framesAnalyzed: times.length, subjectHits: hits }, params: { aspect, samplesPerSecond: req.params.samplesPerSecond ?? 4 } };
    },
  };
}
