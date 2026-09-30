/**
 * ALPHA REFINEMENT stage — a classical (public-domain algorithm, no model,
 * no licensing concern) fast guided filter (He, Sun & Tang, "Guided Image
 * Filtering", 2010), using the source image's own luminance as guidance to
 * sharpen the (bilinear-upsampled, therefore blurry) raw alpha back against
 * real image edges. See MATTE_IMPLEMENTATION_PLAN.md section 7.
 */

/**
 * Separable O(N) box blur via sliding-window sums — used as the guided
 * filter's mean-estimation primitive. Edge handling is replicate-padding:
 * the window is clamped to valid indices, so an out-of-bounds sample reads
 * the nearest edge pixel again rather than being dropped — which is why the
 * normalizer below is always the full `2*radius+1` window size, not a
 * shrinking one (dividing a replicate-padded sum by a shrinking window size
 * was a real bug caught by this module's own tests: it double-counted edge
 * pixels in the sum but normalized as if they hadn't been, inflating every
 * value near the border).
 */
export function boxBlur(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return data.slice();
  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const norm = 1 / (2 * radius + 1);

  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[row + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x++) {
      temp[row + x] = sum * norm;
      const addX = Math.min(width - 1, x + radius + 1);
      const subX = Math.max(0, x - radius);
      sum += data[row + addX] - data[row + subX];
    }
  }

  // Vertical pass.
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum * norm;
      const addY = Math.min(height - 1, y + radius + 1);
      const subY = Math.max(0, y - radius);
      sum += temp[addY * width + x] - temp[subY * width + x];
    }
  }

  return out;
}

function rgbaToLuminance(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const n = width * height;
  const guide = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    guide[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
  }
  return guide;
}

/**
 * Runs the guided filter with the source image's luminance as the guide and
 * `alpha` as the filter input. Output stays continuous in [0,1] — this does
 * NOT threshold or binarize (requirement 5/6): a smooth input alpha with a
 * flat guide image comes back smooth, not snapped to 0/1.
 */
export function guidedFilterAlpha(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  eps: number,
): Float32Array {
  const n = width * height;
  const guide = rgbaToLuminance(rgba, width, height);

  const meanI = boxBlur(guide, width, height, radius);
  const meanP = boxBlur(alpha, width, height, radius);

  const guideSq = new Float32Array(n);
  const guideAlpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    guideSq[i] = guide[i] * guide[i];
    guideAlpha[i] = guide[i] * alpha[i];
  }
  const corrI = boxBlur(guideSq, width, height, radius);
  const corrIP = boxBlur(guideAlpha, width, height, radius);

  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i];
    const covIP = corrIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  const meanA = boxBlur(a, width, height, radius);
  const meanB = boxBlur(b, width, height, radius);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.min(1, Math.max(0, meanA[i] * guide[i] + meanB[i]));
  }
  return out;
}
