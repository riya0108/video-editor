import type { FractionRect } from "../../components/tool/video/RectOverlay";

export interface FractionPoint {
  x: number;
  y: number;
}

/** A tracked position at a point in time — x/y are fractions (0-1), same as FractionRect. */
export interface LogoKeyframe {
  t: number;
  x: number;
  y: number;
}

export type LogoRemovalMode = "reconstruct" | "blur";

export interface LogoRegion {
  id: string;
  shape: "rect" | "brush";
  /** Used when shape === "rect". Also the size (w/h) and fallback position for a tracked region. */
  rect: FractionRect;
  /** Used when shape === "brush" — the path traced while painting, 0-1 fractions. */
  points: FractionPoint[];
  /** Used when shape === "brush". Brush radius as a fraction of min(videoWidth, videoHeight). */
  brushRadius: number;
  /**
   * "reconstruct" (default) rebuilds the box from edges + cloned neighboring
   * texture (see appendDelogoWithClone). "blur" instead just heavily blurs the
   * box in place — cheaper, and the honest choice when there isn't enough
   * clean surrounding texture nearby for a convincing reconstruction (busy,
   * high-motion, or edge-of-frame logos).
   */
  mode: LogoRemovalMode;
  /** 0-100. Reconstruct: how wide a fuzzy edge ffmpeg blends the patch into. Blur: how strong the blur is. */
  strength: number;
  /** null = applied for the whole video. */
  timeRange: { start: number; end: number } | null;
  /**
   * rect-only. 2+ entries make the patch follow a moving watermark: ffmpeg
   * interpolates x/y between keyframes per-frame via an expression, so a
   * single filter still handles the whole clip (see buildLogoRemovalFilter).
   * 0-1 entries behave as a static position (from `rect`).
   */
  keyframes: LogoKeyframe[];
}

function escapeFilterArg(value: string): string {
  return value.replace(/([\\':])/g, "\\$1");
}

/**
 * This build's `delogo` only takes x/y/w/h/show/enable — no blend-radius
 * option — so "strength" instead pads the removed box outward. A bigger box
 * gives delogo more surrounding pixels to interpolate from, which blends
 * better on busy backgrounds at the cost of removing a larger area.
 */
function strengthToPadding(strength: number, w: number, h: number): number {
  const wanted = Math.round((Math.max(0, Math.min(100, strength)) / 100) * 0.25 * Math.min(w, h));
  return Math.max(0, wanted);
}

/** Blur mode's "strength" instead controls how strong the blur itself is — a bigger
 * avgblur kernel, as a fraction of the box's own size, so a small logo and a big one
 * both blur into an equally unrecognizable smear at the same strength setting. */
function strengthToBlurSize(strength: number, w: number, h: number): number {
  const frac = 0.35 + (Math.max(0, Math.min(100, strength)) / 100) * 0.65;
  return Math.max(6, Math.round(frac * Math.min(w, h)));
}

const EDGE_MARGIN = 2;

function pointInAnyRect(p: FractionPoint, rects: FractionRect[]): boolean {
  return rects.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
}

// Chaining many delogo filters is cheap (each is a small box, benchmarked at
// ~0.03s each on a 720p clip natively), but each one still scans the whole
// video once, so a brush stroke is thinned to a bounded number of patches
// spread evenly along the path rather than one per captured pointer sample.
const MAX_BRUSH_SAMPLES = 16;

/** Distributes samples evenly along the whole path (not just the first N captured points), so a long
 * stroke still gets full coverage instead of trailing off into a gap once the cap is hit. */
function sampleBrushPath(points: FractionPoint[], spacingHint: number): FractionPoint[] {
  if (points.length <= 1) return points;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [points[0]];

  const desiredCount = Math.max(2, Math.ceil(total / spacingHint) + 1);
  const count = Math.min(desiredCount, MAX_BRUSH_SAMPLES);
  const step = total / (count - 1);

  const samples: FractionPoint[] = [];
  let segIdx = 1;
  for (let s = 0; s < count; s++) {
    const target = s === count - 1 ? total : s * step;
    while (segIdx < cum.length - 1 && cum[segIdx] < target) segIdx++;
    const segStart = cum[segIdx - 1];
    const segEnd = cum[segIdx];
    const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const a = points[segIdx - 1];
    const b = points[segIdx];
    samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return samples;
}

/** Builds a piecewise-linear ffmpeg expression for one axis from sorted keyframes — holds the first/last
 * value outside the keyframed time range, interpolates linearly between each consecutive pair inside it. */
function keyframePositionExpr(sortedKeyframes: LogoKeyframe[], axis: "x" | "y"): string {
  if (sortedKeyframes.length === 1) return String(sortedKeyframes[0][axis]);
  let expr = String(sortedKeyframes[sortedKeyframes.length - 1][axis]);
  for (let i = sortedKeyframes.length - 2; i >= 0; i--) {
    const a = sortedKeyframes[i];
    const b = sortedKeyframes[i + 1];
    const dt = b.t - a.t;
    const seg = dt > 1e-4 ? `(${a[axis]}+(${b[axis] - a[axis]})*(t-${a.t})/${dt})` : String(a[axis]);
    expr = `if(lt(t,${b.t}),${seg},${expr})`;
  }
  return `if(lt(t,${sortedKeyframes[0].t}),${sortedKeyframes[0][axis]},${expr})`;
}

interface Patch {
  x: string;
  y: string;
  w: string;
  h: string;
  timeRange: LogoRegion["timeRange"];
  mode: LogoRemovalMode;
  /** Blur mode's fixed avgblur kernel size for this patch (see strengthToBlurSize). */
  blurSize: number;
  /** Set only for a static (non-keyframed) rect patch — lets the second pass clone real
   * texture in from a neighboring box instead of leaving delogo's flat interpolation. */
  numeric?: { x: number; y: number; w: number; h: number };
}

function evenRoundLocal(n: number): number {
  return Math.round(n / 2) * 2;
}

/**
 * Finds every same-size box of *real* video just outside the patch (above,
 * below, left, and right of it) usable as a texture donor — skipping any
 * candidate that falls off the frame or overlaps another patch (so one
 * logo's fill doesn't get built out of another logo's box). Returns as many
 * as are valid (0-4), not just the first, so the caller can blend several
 * directions together instead of pasting in one direction's texture verbatim
 * (which is what reads as an obvious "mirrored" patch on a busy background).
 */
function findDonorRects(
  x: number,
  y: number,
  w: number,
  h: number,
  others: { x: number; y: number; w: number; h: number }[],
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number }[] {
  const candidates = [
    { x, y: y - h },
    { x, y: y + h },
    { x: x - w, y },
    { x: x + w, y },
  ];
  const valid: { x: number; y: number }[] = [];
  for (const c of candidates) {
    if (c.x < 0 || c.y < 0 || c.x + w > videoWidth || c.y + h > videoHeight) continue;
    const overlaps = others.some(
      (o) => c.x + w > o.x && o.x + o.w > c.x && c.y + h > o.y && o.y + o.h > c.y,
    );
    if (!overlaps) valid.push({ x: evenRoundLocal(c.x), y: evenRoundLocal(c.y) });
  }
  return valid;
}

/** The blended donor texture is composited over delogo's smoother fill rather than
 * pasted flat, so a mismatched donor (different shadow/gradient) still fades toward
 * delogo's edge-matched base instead of reading as a hard-pasted rectangle. */
const DONOR_OPACITY = 0.62;

/**
 * Appends the filters for one delogo'd box to `parts`, then — if any clean donor
 * boxes are found nearby — clones their real texture in over the delogo fill (see
 * findDonorRects and the buildLogoRemovalFilter doc comment for why). When more than
 * one donor is available they're averaged together first (a running mean built from
 * `overlay` + `colorchannelmixer`, since this build has no `blend`/`avg` filter), so
 * the result reads as a plausible blended texture instead of an obvious copy-pasted
 * chunk from one specific direction. Shared by the multi-region tool and the
 * single-box logo step in the main editor so both get the same quality. `makeLabel`
 * must return a fresh, collision-free label on every call.
 */
export function appendDelogoWithClone(
  parts: string[],
  inputLabel: string,
  x: number,
  y: number,
  w: number,
  h: number,
  others: { x: number; y: number; w: number; h: number }[],
  videoWidth: number,
  videoHeight: number,
  enable: string,
  makeLabel: () => string,
): string {
  const delogoOut = makeLabel();
  parts.push(`[${inputLabel}]delogo=x=${x}:y=${y}:w=${w}:h=${h}${enable}[${delogoOut}]`);

  const rx = Math.round(x);
  const ry = Math.round(y);
  const rw = Math.min(evenRoundLocal(w), videoWidth - rx);
  const rh = Math.min(evenRoundLocal(h), videoHeight - ry);
  const donors = findDonorRects(rx, ry, rw, rh, others, videoWidth, videoHeight);
  if (donors.length === 0) return delogoOut;

  // Each labeled pad can only be consumed once, so the frame needs an N-way split: one
  // copy stays whole (the final overlay's base), one gets cropped to the delogo'd
  // patch, and one per donor gets cropped to that donor's box.
  const outs = Array.from({ length: 2 + donors.length }, () => makeLabel());
  parts.push(`[${delogoOut}]split=${outs.length}[${outs.join("][")}]`);
  const [base, cropSrc, ...donorSrcs] = outs;

  const delogoCrop = makeLabel();
  parts.push(`[${cropSrc}]crop=${rw}:${rh}:${rx}:${ry}[${delogoCrop}]`);

  // Running average of every donor crop: after folding in the k-th donor, giving it
  // weight 1/k keeps the accumulator an equal-weighted mean of all k so far.
  const donorCrops = donorSrcs.map((src, i) => {
    const out = makeLabel();
    parts.push(`[${src}]crop=${rw}:${rh}:${donors[i].x}:${donors[i].y},format=rgba[${out}]`);
    return out;
  });
  let avg = donorCrops[0];
  for (let i = 1; i < donorCrops.length; i++) {
    const weight = (1 / (i + 1)).toFixed(3);
    const weighted = makeLabel();
    parts.push(`[${donorCrops[i]}]colorchannelmixer=aa=${weight}[${weighted}]`);
    const blended = makeLabel();
    parts.push(`[${avg}][${weighted}]overlay[${blended}]`);
    avg = blended;
  }

  // `blend` isn't compiled into this project's minimal ffmpeg-core.wasm build, so the
  // averaged donor's opacity onto the delogo fill is applied via its alpha channel
  // instead: fade it down with colorchannelmixer, then let `overlay` (compiled in and
  // used everywhere else in this codebase) do the actual compositing.
  const avgFaded = makeLabel();
  parts.push(`[${avg}]colorchannelmixer=aa=${DONOR_OPACITY}[${avgFaded}]`);
  const blendedPatch = makeLabel();
  parts.push(`[${delogoCrop}][${avgFaded}]overlay[${blendedPatch}]`);

  const composited = makeLabel();
  parts.push(`[${base}][${blendedPatch}]overlay=x=${rx}:y=${ry}${enable}[${composited}]`);
  return composited;
}

/**
 * Appends the filters for a blurred (not reconstructed) box: crop the patch out, run
 * a heavy `avgblur` over just that crop, and overlay it back in place. x/y/w/h accept
 * either plain numbers or ffmpeg expressions (as strings) — the same values `delogo`
 * takes above — so this works equally for a static box, a tracked/keyframed box, or a
 * brush dab. Cheaper than reconstruction (no donor search or multi-way split) and the
 * honest choice when there isn't enough clean surrounding texture to reconstruct from.
 */
export function appendBlurPatch(
  parts: string[],
  inputLabel: string,
  x: string,
  y: string,
  w: string,
  h: string,
  blurSize: number,
  enable: string,
  makeLabel: () => string,
): string {
  const base = makeLabel();
  const cropSrc = makeLabel();
  parts.push(`[${inputLabel}]split=2[${base}][${cropSrc}]`);
  const cropped = makeLabel();
  parts.push(`[${cropSrc}]crop=${w}:${h}:${x}:${y}[${cropped}]`);
  const blurred = makeLabel();
  parts.push(`[${cropped}]avgblur=sizeX=${blurSize}:sizeY=${blurSize}[${blurred}]`);
  const out = makeLabel();
  parts.push(`[${base}][${blurred}]overlay=x=${x}:y=${y}${enable}[${out}]`);
  return out;
}

/**
 * One patch = one `delogo` filter — ffmpeg's built-in watermark remover,
 * which reconstructs the box from its edge pixels rather than just blurring
 * it. Regions chain sequentially so multiple logos (and multiple brush dabs)
 * can be removed in one export.
 *
 * A tracked rect region (2+ keyframes) still costs exactly one filter: x/y
 * become per-frame expressions ffmpeg evaluates itself (verified against
 * ffmpeg directly — `delogo`'s x/y/w/h options are expressions, not just
 * constants), so a moving watermark doesn't need a filter per frame or per
 * position.
 *
 * (An earlier version used `removelogo` with a full-frame bitmap mask for
 * pixel-precise arbitrary shapes in one filter pass, but that filter's
 * block-matching search benchmarked ~25x slower per pixel than `delogo` even
 * on native ffmpeg — in this single-threaded wasm build it never got past
 * frame 0 on a real video, so exports looked stuck at 0%.)
 *
 * delogo alone reconstructs a box by interpolating *between* its edges, which
 * reads as a soft blur/smudge on any textured background (grass, brick,
 * gradient sky, carpet). For a static (non-keyframed) rect patch, a second
 * pass clones a same-size sample of real neighboring pixels (see
 * findDonorRect) and blends it over the delogo fill — real texture and grain
 * instead of a flat interpolated patch, while delogo's edge-matched result
 * still anchors the boundary underneath if no clean donor box is available.
 */
export function buildLogoRemovalFilter(
  regions: LogoRegion[],
  protectZones: FractionRect[],
  videoWidth: number,
  videoHeight: number,
): { filterComplex: string; outputLabel: string } {
  const patches: Patch[] = [];

  for (const region of regions) {
    if (region.shape === "brush") {
      const radiusPx = region.brushRadius * Math.min(videoWidth, videoHeight);
      if (radiusPx <= 0 || region.points.length === 0) continue;
      const radiusFrac = region.brushRadius;
      const samples = sampleBrushPath(region.points, radiusFrac * 1.3).filter(
        (p) => !pointInAnyRect(p, protectZones),
      );
      const pad = strengthToPadding(region.strength, radiusPx * 2, radiusPx * 2);
      const blurSize = strengthToBlurSize(region.strength, radiusPx * 2, radiusPx * 2);
      for (const p of samples) {
        const cx = p.x * videoWidth;
        const cy = p.y * videoHeight;
        const x = Math.min(Math.max(0, cx - radiusPx - pad), videoWidth - EDGE_MARGIN - 2);
        const y = Math.min(Math.max(0, cy - radiusPx - pad), videoHeight - EDGE_MARGIN - 2);
        const w = Math.min(videoWidth - EDGE_MARGIN - x, radiusPx * 2 + pad * 2);
        const h = Math.min(videoHeight - EDGE_MARGIN - y, radiusPx * 2 + pad * 2);
        patches.push({
          x: String(x),
          y: String(y),
          w: String(w),
          h: String(h),
          timeRange: region.timeRange,
          mode: region.mode,
          blurSize,
        });
      }
      continue;
    }

    const baseW = region.rect.w * videoWidth;
    const baseH = region.rect.h * videoHeight;
    const pad = strengthToPadding(region.strength, baseW, baseH);
    const blurSize = strengthToBlurSize(region.strength, baseW, baseH);

    if (region.keyframes.length >= 2) {
      const sorted = [...region.keyframes].sort((a, b) => a.t - b.t);
      const xFracExpr = keyframePositionExpr(sorted, "x");
      const yFracExpr = keyframePositionExpr(sorted, "y");
      const xFinal = `min(max((${xFracExpr})*${videoWidth}-${pad},0),${videoWidth - EDGE_MARGIN - 2})`;
      const yFinal = `min(max((${yFracExpr})*${videoHeight}-${pad},0),${videoHeight - EDGE_MARGIN - 2})`;
      const wFinal = `min(${videoWidth - EDGE_MARGIN}-(${xFinal}),${baseW + 2 * pad})`;
      const hFinal = `min(${videoHeight - EDGE_MARGIN}-(${yFinal}),${baseH + 2 * pad})`;
      patches.push({ x: xFinal, y: yFinal, w: wFinal, h: hFinal, timeRange: region.timeRange, mode: region.mode, blurSize });
      continue;
    }

    const baseX = region.rect.x * videoWidth;
    const baseY = region.rect.y * videoHeight;
    const x = Math.min(Math.max(0, baseX - pad), videoWidth - EDGE_MARGIN - 2);
    const y = Math.min(Math.max(0, baseY - pad), videoHeight - EDGE_MARGIN - 2);
    const w = Math.min(videoWidth - EDGE_MARGIN - x, baseW + 2 * pad);
    const h = Math.min(videoHeight - EDGE_MARGIN - y, baseH + 2 * pad);
    patches.push({
      x: String(x),
      y: String(y),
      w: String(w),
      h: String(h),
      timeRange: region.timeRange,
      mode: region.mode,
      blurSize,
      numeric: { x, y, w, h },
    });
  }

  const staticBoxes = patches.filter((p) => p.numeric).map((p) => p.numeric!);

  let current = "0:v";
  const parts: string[] = [];
  let tmpId = 0;
  const nextTmp = () => `ldt${tmpId++}`;

  patches.forEach((patch) => {
    const enable = patch.timeRange
      ? `:enable='${escapeFilterArg(`between(t,${patch.timeRange.start},${patch.timeRange.end})`)}'`
      : "";

    if (patch.mode === "blur") {
      const quoted = !patch.numeric;
      const wrap = (v: string) => (quoted ? `'${escapeFilterArg(v)}'` : v);
      current = appendBlurPatch(
        parts,
        current,
        wrap(patch.x),
        wrap(patch.y),
        wrap(patch.w),
        wrap(patch.h),
        patch.blurSize,
        enable,
        nextTmp,
      );
      return;
    }

    if (!patch.numeric) {
      const delogoOut = nextTmp();
      parts.push(
        `[${current}]delogo=x='${escapeFilterArg(patch.x)}':y='${escapeFilterArg(patch.y)}':w='${escapeFilterArg(patch.w)}':h='${escapeFilterArg(patch.h)}'${enable}[${delogoOut}]`,
      );
      current = delogoOut;
      return;
    }

    const { x, y, w, h } = patch.numeric;
    current = appendDelogoWithClone(
      parts,
      current,
      x,
      y,
      w,
      h,
      staticBoxes.filter((b) => b !== patch.numeric),
      videoWidth,
      videoHeight,
      enable,
      nextTmp,
    );
  });

  return { filterComplex: parts.join(";"), outputLabel: current };
}
