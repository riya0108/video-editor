/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. Synthetic scene generation for the
 * permanent benchmark dataset (see dataset.ts / video-dataset.ts).
 *
 * Every scene here is built by DRAWING a known alpha mask ourselves (via
 * Canvas 2D) and then compositing a foreground color over a background
 * using that exact mask — so the ground truth is exact by construction, not
 * estimated or sourced from a third party. This sidesteps two real
 * problems: (1) genuine photographic matting datasets (alphamatting.com,
 * Distinctions-646, PPM-100, etc.) are either not freely redistributable or
 * require a real download from an external source this app has no
 * standing to bundle wholesale, and (2) hand-authoring 35+ real ground-truth
 * mattes is not something this session can responsibly fabricate.
 *
 * Honest limitation, stated once here rather than scattered: these are
 * synthetic PROXIES for each named category (e.g. "curly hair" is many thin
 * bezier strokes, not a real photograph of curly hair) — they exercise the
 * same structural difficulty (fine disconnected detail, low contrast,
 * partial transparency, motion, occlusion, ...) but real-world photographic
 * performance can and likely will differ. Every dataset entry's
 * `description` says so explicitly; the benchmark report repeats this
 * caveat rather than letting a reader assume these are real photos.
 */

export interface SyntheticScene {
  width: number;
  height: number;
  /** A flattened, fully-opaque "photo" (straight RGBA, alpha always 255) — what the matting pipeline actually receives, exactly like a real photograph would give it. */
  compositeRgba: Uint8ClampedArray;
  /** 0-1 per pixel, exact by construction — what the pipeline's OWN alpha output is scored against. */
  groundTruthAlpha: Float32Array;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context is not available in this environment.");
  return { canvas, ctx };
}

function rgbString(c: RgbColor, alpha = 1): string {
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/** Reads a canvas's alpha channel back as a 0-1 mask — used after drawing a shape (with optional blur/AA) on a transparent canvas, so the mask is exactly whatever Canvas 2D actually rasterized, not a hand-rolled approximation of it. */
function alphaChannelOf(ctx: CanvasRenderingContext2D, width: number, height: number): Float32Array {
  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
  return out;
}

/** Draws a simple humanoid silhouette (head + shoulders/torso) centered at `cx` (fraction of width, so callers can offset it for "walking" video cases) — deliberately simple geometry; the point is exercising edge/alpha behavior, not photorealism. */
export function drawHumanoidMask(
  width: number,
  height: number,
  opts: { cx?: number; scale?: number; blurPx?: number; looseClothing?: boolean; rotationDeg?: number } = {},
): Float32Array {
  const { cx = 0.5, scale = 1, blurPx = 0.6, looseClothing = false, rotationDeg = 0 } = opts;
  const { ctx } = makeCanvas(width, height);
  const centerX = width * cx;
  const headR = height * 0.11 * scale;
  const headCy = height * 0.22;
  if (rotationDeg !== 0) {
    // Rotate around the frame center, not the shape's own center, so a
    // rotated subject can genuinely swing partway out of frame (the
    // realistic case this is meant to exercise) rather than just spinning
    // in place.
    ctx.translate(width / 2, height / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
  }
  ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.ellipse(centerX, headCy, headR, headR * 1.15, 0, 0, Math.PI * 2);
  ctx.fill();

  const shoulderY = headCy + headR * 1.6;
  const bodyBottom = height * 0.95;
  const shoulderHalfW = headR * (looseClothing ? 2.6 : 1.9);
  const hipHalfW = headR * (looseClothing ? 3.2 : 1.5);
  ctx.beginPath();
  ctx.moveTo(centerX - shoulderHalfW, shoulderY);
  ctx.quadraticCurveTo(centerX - hipHalfW * 1.1, (shoulderY + bodyBottom) / 2, centerX - hipHalfW, bodyBottom);
  ctx.lineTo(centerX + hipHalfW, bodyBottom);
  ctx.quadraticCurveTo(centerX + hipHalfW * 1.1, (shoulderY + bodyBottom) / 2, centerX + shoulderHalfW, shoulderY);
  ctx.closePath();
  ctx.fill();

  return alphaChannelOf(ctx, width, height);
}

/** Simple product-like shape (rounded bottle silhouette) — the EASY "product on plain background" case. */
export function drawProductMask(width: number, height: number, opts: { blurPx?: number } = {}): Float32Array {
  const { blurPx = 0.4 } = opts;
  const { ctx } = makeCanvas(width, height);
  ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
  ctx.fillStyle = "black";
  const cx = width / 2;
  const top = height * 0.15;
  const bottom = height * 0.88;
  const bodyW = width * 0.22;
  const neckW = width * 0.08;
  const neckBottom = top + (bottom - top) * 0.18;
  ctx.beginPath();
  ctx.moveTo(cx - neckW / 2, top);
  ctx.lineTo(cx + neckW / 2, top);
  ctx.lineTo(cx + neckW / 2, neckBottom);
  ctx.quadraticCurveTo(cx + bodyW / 2, neckBottom, cx + bodyW / 2, neckBottom + (bottom - neckBottom) * 0.25);
  ctx.lineTo(cx + bodyW / 2, bottom - 10);
  ctx.quadraticCurveTo(cx + bodyW / 2, bottom, cx + bodyW / 2 - 10, bottom);
  ctx.lineTo(cx - bodyW / 2 + 10, bottom);
  ctx.quadraticCurveTo(cx - bodyW / 2, bottom, cx - bodyW / 2, bottom - 10);
  ctx.lineTo(cx - bodyW / 2, neckBottom + (bottom - neckBottom) * 0.25);
  ctx.quadraticCurveTo(cx - bodyW / 2, neckBottom, cx - neckW / 2, neckBottom);
  ctx.closePath();
  ctx.fill();
  return alphaChannelOf(ctx, width, height);
}

/** A plain high-contrast geometric shape (sharp edges, no blur) — the EASY "high contrast object" case. */
export function drawHighContrastMask(width: number, height: number): Float32Array {
  const { ctx } = makeCanvas(width, height);
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.3, 0, Math.PI * 2);
  ctx.fill();
  return alphaChannelOf(ctx, width, height);
}

/** Adds thin, curved, low-alpha strand strokes around the head region of an existing mask (in place, by max-combining) — a synthetic proxy for hair fringe. `curl` toggles between fairly straight fine strands and tightly-curled loops. */
export function addHairStrands(
  base: Float32Array,
  width: number,
  height: number,
  opts: { curl?: boolean; density?: number; cx?: number; phase?: number } = {},
): Float32Array {
  const { curl = false, density = 40, cx = 0.5, phase = 0 } = opts;
  const { ctx } = makeCanvas(width, height);
  const centerX = width * cx;
  const headCy = height * 0.22;
  const headR = height * 0.11;
  ctx.strokeStyle = "black";
  ctx.lineCap = "round";
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < density; i++) {
    const angle = -Math.PI * 0.9 + rand() * Math.PI * 1.8 + phase;
    const startX = centerX + Math.cos(angle) * headR * 0.9;
    const startY = headCy + Math.sin(angle) * headR * 0.9 - headR * 0.2;
    const length = headR * (0.6 + rand() * 1.2);
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    ctx.lineWidth = curl ? 1.4 : 0.8;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    if (curl) {
      const loops = 1 + rand() * 1.5;
      const steps = 12;
      let px = startX;
      let py = startY;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const r = length * 0.18 * (1 - t * 0.3);
        const a = angle + t * Math.PI * 2 * loops;
        px = startX + Math.cos(a) * r * t * 3;
        py = startY + Math.sin(angle) * length * t + Math.sin(a) * r;
        ctx.lineTo(px, py);
      }
    } else {
      const endX = startX + Math.cos(angle) * length * 0.3 + (rand() - 0.5) * 6;
      const endY = startY + Math.sin(angle) * length;
      ctx.quadraticCurveTo((startX + endX) / 2 + (rand() - 0.5) * 10, (startY + endY) / 2, endX, endY);
    }
    ctx.stroke();
  }
  const strands = alphaChannelOf(ctx, width, height);
  const out = new Float32Array(base.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(base[i], strands[i]);
  return out;
}

/**
 * PHASE 16 — ADVERSARIAL MATTE TESTING ("fur"). Distinct from
 * `addHairStrands`: fur covers a much wider area (the whole body silhouette,
 * not just a head fringe) with many very short, dense strokes rather than a
 * few long ones — a different structural difficulty (a fuzzy boundary along
 * the ENTIRE outline, not just localized at the top).
 */
export function addFurCoverage(base: Float32Array, width: number, height: number, density = 250): Float32Array {
  const { ctx } = makeCanvas(width, height);
  ctx.strokeStyle = "black";
  ctx.lineCap = "round";
  let seed = 24681357;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // Sample stroke origins from the base mask's own boundary pixels — a
  // cheap boundary proxy: any foreground pixel adjacent to a background one.
  const boundary: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (base[i] <= 0.05) continue;
      if (base[i - 1] <= 0.05 || base[i + 1] <= 0.05 || base[i - width] <= 0.05 || base[i + width] <= 0.05) boundary.push(i);
    }
  }
  if (boundary.length === 0) return base.slice();
  for (let i = 0; i < density; i++) {
    const idx = boundary[Math.floor(rand() * boundary.length)];
    const x = idx % width;
    const y = (idx / width) | 0;
    const angle = rand() * Math.PI * 2;
    const length = height * (0.015 + rand() * 0.02);
    ctx.globalAlpha = 0.3 + rand() * 0.5;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  const fuzz = alphaChannelOf(ctx, width, height);
  const out = new Float32Array(base.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(base[i], fuzz[i]);
  return out;
}

/**
 * PHASE 16 — ADVERSARIAL MATTE TESTING ("smoke-like regions"). Several
 * overlapping, heavily-blurred, low-opacity blobs — a soft, spatially
 * diffuse region with no hard boundary anywhere, unlike every other case in
 * this dataset. Specifically exercises whether the pipeline either (a)
 * crashes/NaNs on very-low, gradually-varying alpha, or (b) silently
 * collapses it to "confidently nothing here" — a plausible-but-wrong
 * response to a genuinely ambiguous, low-alpha subject.
 */
export function makeSmokeMask(width: number, height: number, cx = 0.5, cy = 0.5): Float32Array {
  const { ctx } = makeCanvas(width, height);
  ctx.filter = `blur(${Math.round(height * 0.05)}px)`;
  ctx.fillStyle = "black";
  let seed = 13579246;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 10; i++) {
    ctx.globalAlpha = 0.08 + rand() * 0.1;
    const bx = width * (cx + (rand() - 0.5) * 0.35);
    const by = height * (cy + (rand() - 0.5) * 0.45);
    const r = width * (0.08 + rand() * 0.12);
    ctx.beginPath();
    ctx.ellipse(bx, by, r, r * (0.8 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return alphaChannelOf(ctx, width, height);
}

/** Uniformly scales an alpha mask's foreground region toward partial opacity — the HARD "transparent objects" case (e.g. glass). */
export function makeUniformlyTransparent(mask: Float32Array, opacity: number): Float32Array {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] * opacity;
  return out;
}

/** Spatially-varying partial opacity across the foreground region — the HARD "semi-transparent fabric" case (silk/sheer). Opacity ramps smoothly by row so the result isn't just uniform "transparent objects" again. */
export function makeGradientTransparent(mask: Float32Array, width: number, height: number, minOpacity: number, maxOpacity: number): Float32Array {
  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const opacity = minOpacity + (maxOpacity - minOpacity) * t;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      out[i] = mask[i] * opacity;
    }
  }
  return out;
}

/** Directional motion-trail blur: draws several offset, decreasing-opacity copies of the mask instead of an isotropic Gaussian blur, which reads much more like real motion blur than `filter: blur()` would. */
export function applyMotionTrail(mask: Float32Array, width: number, height: number, dx: number, steps = 6): Float32Array {
  const out = new Float32Array(mask.length);
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1);
    const offset = Math.round((t - 0.5) * dx);
    const weight = 1 - Math.abs(t - 0.5) * 1.6;
    if (weight <= 0) continue;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcX = x - offset;
        if (srcX < 0 || srcX >= width) continue;
        const v = mask[y * width + srcX] * weight;
        const di = y * width + x;
        if (v > out[di]) out[di] = v;
      }
    }
  }
  return out;
}

/** Fills a background with either a flat color or a busy synthetic pattern (many small random shapes) — the MEDIUM "textured background" / HARD "complex background" cases. `offsetX` shifts every shape's x position by a fixed amount (wrapping) — the same seeded shape sequence at a different offset gives a stable panning-camera effect for video cases rather than fresh random noise per frame. */
export function paintBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: RgbColor,
  opts: { textured?: boolean; complex?: boolean; offsetX?: number } = {},
): void {
  ctx.fillStyle = rgbString(color);
  ctx.fillRect(0, 0, width, height);
  if (!opts.textured && !opts.complex) return;

  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const offsetX = opts.offsetX ?? 0;
  const shapeCount = opts.complex ? 90 : 35;
  for (let i = 0; i < shapeCount; i++) {
    const shade = opts.complex ? rand() * 255 : Math.max(0, Math.min(255, color.r + (rand() - 0.5) * 40));
    const alt: RgbColor = opts.complex
      ? { r: shade, g: rand() * 255, b: rand() * 255 }
      : { r: shade, g: Math.max(0, Math.min(255, color.g + (rand() - 0.5) * 40)), b: Math.max(0, Math.min(255, color.b + (rand() - 0.5) * 40)) };
    ctx.fillStyle = rgbString(alt, opts.complex ? 0.55 : 0.35);
    const w = width * (0.03 + rand() * (opts.complex ? 0.12 : 0.05));
    const h = height * (0.03 + rand() * (opts.complex ? 0.12 : 0.05));
    const x = (((rand() * width + offsetX) % width) + width) % width;
    ctx.beginPath();
    ctx.ellipse(x, rand() * height, w, h, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A small independent limb-like blob (a proxy "hand") at an arbitrary position — combined via max() with a body mask for the VIDEO "hand movement" case, where it moves independently frame to frame while the body stays put. */
export function drawHandMask(width: number, height: number, handXFrac: number, handYFrac: number, radiusFrac = 0.045): Float32Array {
  const { ctx } = makeCanvas(width, height);
  ctx.filter = "blur(0.5px)";
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.ellipse(width * handXFrac, height * handYFrac, width * radiusFrac, width * radiusFrac * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  return alphaChannelOf(ctx, width, height);
}

/** Zeroes alpha within a vertical band — simulates an opaque, non-subject object passing in front of and hiding part of the subject. Ground truth alpha in a genuinely hidden region is legitimately 0 (nothing of the subject is visible there), which is what a real matting ground truth would show too. */
export function applyOccluderBand(mask: Float32Array, width: number, height: number, bandCenterXFrac: number, bandWidthFrac = 0.16): Float32Array {
  const out = mask.slice();
  const cx = width * bandCenterXFrac;
  const halfW = (width * bandWidthFrac) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = Math.max(0, Math.floor(cx - halfW)); x < Math.min(width, Math.ceil(cx + halfW)); x++) {
      out[y * width + x] = 0;
    }
  }
  return out;
}

/** Paints the actual occluding object into the flattened photo so the pipeline genuinely sees something opaque blocking the subject, matching `applyOccluderBand`'s band. */
export function paintOccluderBand(ctx: CanvasRenderingContext2D, width: number, height: number, bandCenterXFrac: number, bandWidthFrac = 0.16, color: RgbColor = { r: 70, g: 70, b: 75 }): void {
  const cx = width * bandCenterXFrac;
  const halfW = (width * bandWidthFrac) / 2;
  ctx.fillStyle = rgbString(color);
  ctx.fillRect(cx - halfW, 0, halfW * 2, height);
}

/** Draws a soft dark ellipse (a cast shadow) into an already-painted background layer — ground truth alpha for this region is 0 (it's not the subject), specifically testing whether the pipeline wrongly attributes alpha to a shadow. */
export function paintShadow(ctx: CanvasRenderingContext2D, width: number, height: number, cx: number): void {
  ctx.save();
  ctx.filter = "blur(8px)";
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(width * cx + width * 0.06, height * 0.92, width * 0.16, height * 0.035, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Draws a faint, vertically-flipped, blurred echo of the subject below it (a floor/water reflection) directly into the flattened photo — again ground truth alpha for the reflection is 0. */
export function paintReflection(ctx: CanvasRenderingContext2D, width: number, height: number, subjectMask: Float32Array, fg: RgbColor): void {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.filter = "blur(3px)";
  ctx.translate(0, height * 1.85);
  ctx.scale(1, -1);
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext("2d")!;
  const img = tctx.createImageData(width, height);
  for (let i = 0; i < subjectMask.length; i++) {
    img.data[i * 4] = fg.r;
    img.data[i * 4 + 1] = fg.g;
    img.data[i * 4 + 2] = fg.b;
    img.data[i * 4 + 3] = Math.round(subjectMask[i] * 255);
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

/** Composites a solid-colored foreground (using `mask` as its alpha) over a background painted by `paintBg`, flattening to an opaque RGB "photo" plus the exact ground-truth alpha that was used. */
export function composeScene(
  width: number,
  height: number,
  fg: RgbColor,
  bg: RgbColor,
  mask: Float32Array,
  opts: { paintBg?: (ctx: CanvasRenderingContext2D) => void; paintOver?: (ctx: CanvasRenderingContext2D) => void } = {},
): SyntheticScene {
  const { ctx } = makeCanvas(width, height);
  if (opts.paintBg) opts.paintBg(ctx);
  else paintBackground(ctx, width, height, bg);

  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i];
    const o = i * 4;
    data[o] = Math.round(fg.r * a + data[o] * (1 - a));
    data[o + 1] = Math.round(fg.g * a + data[o + 1] * (1 - a));
    data[o + 2] = Math.round(fg.b * a + data[o + 2] * (1 - a));
    data[o + 3] = 255;
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  if (opts.paintOver) opts.paintOver(ctx);

  const finalData = ctx.getImageData(0, 0, width, height).data;
  const compositeRgba = new Uint8ClampedArray(finalData.length);
  compositeRgba.set(finalData);
  return { width, height, compositeRgba, groundTruthAlpha: mask };
}
