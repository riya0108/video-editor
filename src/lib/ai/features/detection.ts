import { AIError, throwIfAborted } from "../errors";
import { sampleTimes, type AIFrame } from "../media";
import { itemId, type AIProvider, type Availability } from "../provider";
import { conf, type AIFeatureId, type Box, type Detection, type DetectionTrackItem, type ModelInfo } from "../types";

/**
 * FACE & OBJECT DETECTION — real neural networks (MediaPipe BlazeFace / EfficientDet-Lite0, see
 * detectors-mediapipe.ts), behind a small backend interface so the provider, the IoU tracker and the result model are
 * testable without a GPU and a different detector can be swapped in.
 *
 * Frames are sampled across the clip; per-frame detections are LINKED into tracks (same label, IoU >= 0.3 with the
 * track's last box, gaps of up to 2 samples bridged), so the result is "this face from 1.2 s to 6.8 s" rather than
 * hundreds of loose boxes. Track confidence = mean model score x how consistently it was seen over its span.
 */

export interface RawDetection {
  box: Box;
  label: string;
  score: number;
  keypoints?: { x: number; y: number }[];
}

export interface DetectorBackend {
  detect(frame: AIFrame): Promise<RawDetection[]>;
}

export interface DetectionParams {
  samplesPerSecond?: number;
  minScore?: number;
  /** Object detection: only keep these labels (COCO names), e.g. ["person"]. */
  labels?: string[];
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Greedy IoU linking of per-sample detections into tracks. `times` are the sample times (ascending). */
export function linkDetections(perSample: Detection[][], times: number[], opts: { iouThreshold?: number; maxGap?: number } = {}): Detection[][] {
  const th = opts.iouThreshold ?? 0.3;
  const maxGap = opts.maxGap ?? 2;
  const tracks: { dets: Detection[]; lastIdx: number }[] = [];
  perSample.forEach((dets, si) => {
    const sorted = [...dets].sort((a, b) => b.confidence.value - a.confidence.value);
    const used = new Set<number>();
    for (const d of sorted) {
      let best = -1;
      let bestIou = th;
      tracks.forEach((t, ti) => {
        if (used.has(ti) || si - t.lastIdx > maxGap + 1 || si === t.lastIdx) return;
        const last = t.dets[t.dets.length - 1];
        if (last.label !== d.label) return;
        const o = iou(last.box, d.box);
        if (o >= bestIou) {
          bestIou = o;
          best = ti;
        }
      });
      if (best >= 0) {
        tracks[best].dets.push(d);
        tracks[best].lastIdx = si;
        used.add(best);
      } else {
        tracks.push({ dets: [d], lastIdx: si });
        used.add(tracks.length - 1);
      }
    }
  });
  void times;
  return tracks.map((t) => t.dets);
}

export function tracksToItems(tracks: Detection[][], times: number[], sampleInterval: number): DetectionTrackItem[] {
  return tracks
    .map((dets) => {
      const start = dets[0].time;
      const end = dets[dets.length - 1].time;
      const span = Math.max(1, Math.round((end - start) / sampleInterval) + 1);
      const mean = dets.reduce((s, d) => s + d.confidence.value, 0) / dets.length;
      const consistency = Math.min(1, dets.length / span);
      return {
        kind: "detection-track" as const,
        id: itemId("det"),
        accepted: true,
        label: dets[0].label,
        detections: dets,
        start: +Math.max(times[0] ?? start, start - sampleInterval / 2).toFixed(3),
        end: +(end + sampleInterval / 2).toFixed(3),
        confidence: conf(mean * consistency, "model-score"),
      };
    })
    .sort((a, b) => a.start - b.start || b.confidence.value - a.confidence.value);
}

export function createDetectionProvider(spec: { id: string; feature: AIFeatureId; label: string; description: string; model: ModelInfo; load: () => Promise<DetectorBackend>; available: () => Availability; defaultSamplesPerSecond: number }): AIProvider<DetectionParams> {
  return {
    id: spec.id,
    feature: spec.feature,
    label: spec.label,
    kind: "ml-model",
    model: spec.model,
    description: spec.description,
    needs: { video: true },
    availability: spec.available,
    async run(req, ctx) {
      if (!req.media.hasVideo) throw new AIError("media-unavailable", "This clip has no picture.");
      ctx.progress(0.02, "Loading model");
      let backend: DetectorBackend;
      try {
        backend = await spec.load();
      } catch (e) {
        throw new AIError("model-load-failed", `${spec.model.name} failed to load: ${(e as Error).message}`, e);
      }
      throwIfAborted(ctx.signal);
      const rate = req.params.samplesPerSecond ?? spec.defaultSamplesPerSecond;
      const times = req.media.still ? [req.media.sourceStart] : sampleTimes(req.media.sourceStart, req.media.sourceEnd, rate, 600);
      const minScore = req.params.minScore ?? 0.5;
      const perSample: Detection[][] = [];
      let total = 0;
      for (let k = 0; k < times.length; k++) {
        throwIfAborted(ctx.signal);
        const frame = await req.media.frameAt(times[k], 640);
        let raw: RawDetection[];
        try {
          raw = await backend.detect(frame);
        } catch (e) {
          throw new AIError("inference-failed", `${spec.model.name} failed on a frame: ${(e as Error).message}`, e);
        }
        const dets = raw
          .filter((r) => r.score >= minScore && (!req.params.labels || req.params.labels.includes(r.label)))
          .map((r): Detection => ({ time: times[k], box: r.box, label: r.label, confidence: conf(r.score, "model-score"), ...(r.keypoints ? { keypoints: r.keypoints } : {}) }));
        total += dets.length;
        perSample.push(dets);
        ctx.progress(0.05 + (0.9 * (k + 1)) / times.length, "Detecting");
      }
      const interval = times.length > 1 ? times[1] - times[0] : 1;
      const items = tracksToItems(linkDetections(perSample, times), times, interval);
      return { items, warnings: total === 0 ? [`No ${spec.feature === "face-detection" ? "faces" : "objects"} were detected above ${Math.round(minScore * 100)}% confidence.`] : [], metrics: { framesAnalyzed: times.length, detections: total }, params: { samplesPerSecond: rate, minScore, ...(req.params.labels ? { labels: req.params.labels } : {}) } };
    },
  };
}
