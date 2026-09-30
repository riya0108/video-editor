/**
 * ALPHA NORMALIZATION — a safety/sanitization pass, not a contrast-stretch
 * (that's a distinct, explicit operation — see contrast.ts). Guards against
 * NaN/Infinity (which a division in an upstream stage, e.g. a degenerate
 * guided-filter variance, could in principle produce) and clamps to the
 * valid [0,1] range. Always non-destructive: returns a new array, never
 * mutates its input.
 */
export function normalizeAlpha(alpha: Float32Array): Float32Array {
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const v = alpha[i];
    out[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
  return out;
}
