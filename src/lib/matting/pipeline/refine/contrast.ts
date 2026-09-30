import { TrimapLabel } from "./trimap";

/**
 * CONTRAST — reshapes how steeply alpha transitions from 0 to 1 within the
 * unknown band, without moving the boundary's position (contrast that's
 * distinct from shiftEdgeAlpha in shape-ops.ts). `amount` > 0 sharpens
 * (pushes values away from 0.5 toward the extremes — a crisper edge);
 * `amount` < 0 softens (pulls values toward 0.5 — a more graded edge); 0 is
 * a no-op. Restricted to the unknown band, same rationale as
 * smoothing-ops.ts's blendWhereUnknown.
 */
export function applyAlphaContrast(alpha: Float32Array, trimap: Uint8Array, amount: number): Float32Array {
  if (amount === 0) return alpha.slice();
  const factor = Math.max(0, 1 + amount);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    if (trimap[i] !== TrimapLabel.Unknown) {
      out[i] = alpha[i];
      continue;
    }
    const shifted = 0.5 + (alpha[i] - 0.5) * factor;
    out[i] = Math.min(1, Math.max(0, shifted));
  }
  return out;
}
