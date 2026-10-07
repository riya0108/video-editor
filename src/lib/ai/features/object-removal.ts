import { AIError, throwIfAborted } from "../errors";
import { sampleTimes, type AIFrame } from "../media";
import { itemId, type AIProvider } from "../provider";
import { conf, type Box, type ObjectRemovalItem } from "../types";

/**
 * OBJECT REMOVAL — classical computer vision (temporal clean plate + harmonic inpainting). No inpainting network is
 * bundled in this app, so this does NOT hallucinate new content; it recovers what was really there:
 *
 *  1. Sample frames across the clip. Inside the region, the per-pixel TEMPORAL MEDIAN is the background wherever a
 *     moving object covers that pixel less than half the time (a passer-by, a car, a boom mic dipping in).
 *  2. Pixels where samples disagree with the median too often (the object sat there most of the time), or a region
 *     where nothing moves at all (a static object/logo — the median would just be the object), are filled by
 *     HARMONIC (Laplace) interpolation from the region's border: smooth, honest, works for plain backgrounds,
 *     blurry on texture.
 *  3. The result is a transparent full-frame PATCH (feathered edge) registered as a new source. Applying it adds an
 *     overlay layer above the clip — the original media is never touched, and the patch layer can be moved, masked,
 *     faded or deleted.
 *
 * Valid only for a STATIC camera: camera motion is measured from the pixels around the region and reported (with a
 * lower confidence) when present. Confidence = fraction of region pixels filled from real background samples.
 */

export interface ObjectRemovalParams {
  region: Box;
  samples?: number;
  /** Feather width around the region, as a fraction of the region's shorter side. */
  feather?: number;
}

const ANALYSIS_SIDE = 960;

export interface CleanPlate {
  /** Full-frame RGBA (frame size), transparent outside the region + feather. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  method: ObjectRemovalItem["method"];
  realBackgroundFraction: number;
  /** Median temporal std (0..255) of the ring around the region: ~0-3 static camera, larger = camera/scene motion. */
  cameraMotion: number;
}

function median(values: number[]): number {
  const s = values.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Harmonic fill of `unknown` pixels (Gauss-Seidel on a coarse-to-fine pyramid), per channel, in place over rgb (3 floats/px). */
export function harmonicFill(rgb: Float32Array, unknown: Uint8Array, w: number, h: number, iterations = 300): void {
  // Initialise unknowns with the mean of known pixels so iteration starts near the answer.
  const mean = [0, 0, 0];
  let known = 0;
  for (let i = 0; i < w * h; i++)
    if (!unknown[i]) {
      for (let c = 0; c < 3; c++) mean[c] += rgb[i * 3 + c];
      known++;
    }
  for (let c = 0; c < 3; c++) mean[c] /= Math.max(1, known);
  for (let i = 0; i < w * h; i++) if (unknown[i]) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = mean[c];
  // Coarse level first (fast propagation of border colours over large holes).
  if (w > 24 && h > 24) {
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    const crgb = new Float32Array(cw * ch * 3);
    const cunk = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        let n = 0;
        let u = 0;
        const acc = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx);
            const sy = Math.min(h - 1, y * 2 + dy);
            const i = sy * w + sx;
            if (unknown[i]) u++;
            else {
              for (let c = 0; c < 3; c++) acc[c] += rgb[i * 3 + c];
              n++;
            }
          }
        const ci = y * cw + x;
        cunk[ci] = n === 0 ? 1 : 0;
        for (let c = 0; c < 3; c++) crgb[ci * 3 + c] = n ? acc[c] / n : mean[c];
        void u;
      }
    harmonicFill(crgb, cunk, cw, ch, iterations);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!unknown[i]) continue;
        const ci = Math.min(ch - 1, y >> 1) * cw + Math.min(cw - 1, x >> 1);
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = crgb[ci * 3 + c];
      }
  }
  const idx: number[] = [];
  for (let i = 0; i < w * h; i++) if (unknown[i]) idx.push(i);
  for (let it = 0; it < iterations; it++) {
    for (const i of idx) {
      const x = i % w;
      const y = (i - x) / w;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let n = 0;
        if (x > 0) (s += rgb[(i - 1) * 3 + c]), n++;
        if (x < w - 1) (s += rgb[(i + 1) * 3 + c]), n++;
        if (y > 0) (s += rgb[(i - w) * 3 + c]), n++;
        if (y < h - 1) (s += rgb[(i + w) * 3 + c]), n++;
        rgb[i * 3 + c] = s / n;
      }
    }
  }
}

/** Pure clean-plate builder over same-size frames. `region` is normalized. */
export function buildCleanPlate(frames: AIFrame[], region: Box, featherFrac = 0.15): CleanPlate {
  const W = frames[0].width;
  const H = frames[0].height;
  const rx0 = Math.max(0, Math.floor(region.x * W));
  const ry0 = Math.max(0, Math.floor(region.y * H));
  const rx1 = Math.min(W, Math.ceil((region.x + region.w) * W));
  const ry1 = Math.min(H, Math.ceil((region.y + region.h) * H));
  if (rx1 - rx0 < 2 || ry1 - ry0 < 2) throw new AIError("invalid-input", "The region is too small.");
  const feather = Math.max(1, Math.round(Math.min(rx1 - rx0, ry1 - ry0) * featherFrac));
  // Working window = region + feather + a 2 px border of known pixels for the fill.
  const wx0 = Math.max(0, rx0 - feather - 2);
  const wy0 = Math.max(0, ry0 - feather - 2);
  const wx1 = Math.min(W, rx1 + feather + 2);
  const wy1 = Math.min(H, ry1 + feather + 2);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const rgb = new Float32Array(ww * wh * 3);
  const agreement = new Float32Array(ww * wh);
  const tolerance = 20;
  let movingPixels = 0;
  const vals: number[] = new Array(frames.length);
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const p = ((wy0 + y) * W + wx0 + x) * 4;
      let agreeAll = frames.length;
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < frames.length; k++) vals[k] = frames[k].data[p + c];
        const m = median(vals.slice());
        rgb[(y * ww + x) * 3 + c] = m;
        let agree = 0;
        for (let k = 0; k < frames.length; k++) if (Math.abs(frames[k].data[p + c] - m) <= tolerance) agree++;
        agreeAll = Math.min(agreeAll, agree);
      }
      agreement[y * ww + x] = agreeAll / frames.length;
      const inRegion = wx0 + x >= rx0 && wx0 + x < rx1 && wy0 + y >= ry0 && wy0 + y < ry1;
      if (inRegion && agreement[y * ww + x] < 0.95) movingPixels++;
    }
  const regionPixels = (rx1 - rx0) * (ry1 - ry0);
  // Nothing moves inside the region: a static object. The median is the object itself -> fill the whole region.
  const staticObject = movingPixels / regionPixels < 0.02;
  const unknown = new Uint8Array(ww * wh);
  let filled = 0;
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const inRegion = wx0 + x >= rx0 && wx0 + x < rx1 && wy0 + y >= ry0 && wy0 + y < ry1;
      if (!inRegion) continue;
      if (staticObject || agreement[y * ww + x] < 0.5) {
        unknown[y * ww + x] = 1;
        filled++;
      }
    }
  if (filled > 0) harmonicFill(rgb, unknown, ww, wh);
  // Camera motion: MEDIAN temporal std on the ring between region and window edge. A moving camera changes nearly
  // every ring pixel; the object being removed walking out through the ring changes only some — a mean counted that
  // as camera motion (live test: a locked-off shot was flagged at "motion 9.2").
  const ringStds: number[] = [];
  for (let y = 0; y < wh; y += 2)
    for (let x = 0; x < ww; x += 2) {
      const gx = wx0 + x;
      const gy = wy0 + y;
      if (gx >= rx0 && gx < rx1 && gy >= ry0 && gy < ry1) continue;
      const p = (gy * W + gx) * 4 + 1; // green channel ~ luma
      let m = 0;
      for (const f of frames) m += f.data[p];
      m /= frames.length;
      let v = 0;
      for (const f of frames) v += (f.data[p] - m) ** 2;
      ringStds.push(Math.sqrt(v / frames.length));
    }
  const cameraMotion = ringStds.length ? median(ringStds) : 0;
  // Full-frame transparent patch with a feathered edge around the region.
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const gx = wx0 + x;
      const gy = wy0 + y;
      const dx = Math.max(rx0 - gx, gx - (rx1 - 1), 0);
      const dy = Math.max(ry0 - gy, gy - (ry1 - 1), 0);
      const dist = Math.hypot(dx, dy);
      const a = dist === 0 ? 1 : Math.max(0, 1 - dist / feather);
      if (a <= 0) continue;
      const o = (gy * W + gx) * 4;
      const i = (y * ww + x) * 3;
      out[o] = rgb[i];
      out[o + 1] = rgb[i + 1];
      out[o + 2] = rgb[i + 2];
      out[o + 3] = Math.round(a * 255);
    }
  return {
    rgba: out,
    width: W,
    height: H,
    method: filled > 0 ? "temporal-plate+diffusion" : "temporal-plate",
    realBackgroundFraction: staticObject ? 0 : 1 - filled / regionPixels,
    cameraMotion,
  };
}

export const objectRemovalProvider: AIProvider<ObjectRemovalParams> = {
  id: "object-removal.clean-plate",
  feature: "object-removal",
  label: "Object removal",
  kind: "classical-cv",
  description: "Removes a moving object from a static shot by recovering the real background (temporal median clean plate), with smooth border fill where the background is never seen. Not generative; static camera only.",
  needs: { video: true, region: true },
  availability: (services) => (services.registerImage ? { available: true } : { available: false, reason: "No image registration service (needs the composition editor's frame provider)." }),
  async run(req, ctx) {
    const p = req.params;
    if (!p?.region || !(p.region.w > 0 && p.region.h > 0)) throw new AIError("invalid-input", "Choose the region to remove (or pick a detected object).");
    if (!req.media.hasVideo) throw new AIError("media-unavailable", "This clip has no picture.");
    if (!ctx.services.registerImage) throw new AIError("provider-unavailable", "Object removal needs the editor's image registration service.");
    const times = sampleTimes(req.media.sourceStart, req.media.sourceEnd, 6, p.samples ?? 31);
    const frames: AIFrame[] = [];
    for (let k = 0; k < times.length; k++) {
      throwIfAborted(ctx.signal);
      frames.push(await req.media.frameAt(times[k], ANALYSIS_SIDE));
      ctx.progress((0.7 * (k + 1)) / times.length, "Reading frames");
    }
    ctx.progress(0.75, "Building clean plate");
    const plate = buildCleanPlate(frames, p.region, p.feather ?? 0.15);
    throwIfAborted(ctx.signal);
    const plateSourceId = ctx.services.registerImage(`aiplate:${req.sourceId}:${itemId("p")}`, plate.rgba, plate.width, plate.height);
    const warnings: string[] = [];
    if (plate.cameraMotion > 8) warnings.push(`The camera (or the scene around the region) moves (motion ${plate.cameraMotion.toFixed(1)}): a single clean plate will not line up in every frame.`);
    if (plate.method !== "temporal-plate") warnings.push(plate.realBackgroundFraction === 0 ? "Nothing moves inside the region (a static object): it was filled smoothly from its border — no real background was available." : `${Math.round((1 - plate.realBackgroundFraction) * 100)}% of the region was never clear of the object and was filled smoothly from its border.`);
    const motionPenalty = plate.cameraMotion > 8 ? 0.5 : 1;
    const item: ObjectRemovalItem = { kind: "object-removal", id: itemId("rm"), accepted: true, region: p.region, method: plate.method, plateSourceId, realBackgroundFraction: +plate.realBackgroundFraction.toFixed(3), cameraMotion: +plate.cameraMotion.toFixed(2), confidence: conf(plate.realBackgroundFraction * motionPenalty, "agreement") };
    return { items: [item], warnings, metrics: { framesAnalyzed: frames.length, plateWidth: plate.width, plateHeight: plate.height }, params: { region: p.region, samples: frames.length, feather: p.feather ?? 0.15 } };
  },
};
