import { labelConnectedComponents } from "./connected-components";

/**
 * SMALL-HOLE CLEANUP, SMALL-ISLAND CLEANUP, and FINE-DETAIL PRESERVATION.
 *
 * A hole is a small connected "background" region (alpha <= threshold)
 * fully enclosed by foreground — doesn't touch the image border — usually
 * model noise (a gap in a shirt, a spot on skin the model briefly doubted).
 * Filled to fully opaque.
 *
 * An island is a small connected "foreground" region (alpha > threshold)
 * disconnected from everything else — usually a stray high-confidence
 * speck the model hallucinated. Suppressed to fully transparent.
 *
 * FINE-DETAIL PRESERVATION is the exception to island cleanup: a small,
 * disconnected blob that substantially overlaps the fine-detail mask (see
 * trimap.ts's buildFineDetailMask — real Sobel edge-energy on the source
 * image, not a guess) is a plausible genuine detail (an isolated hair
 * strand or wisp naturally *is* small and disconnected from the main mass)
 * and is left alone instead of being erased as if it were noise.
 */

export interface CleanupOptions {
  /** Enclosed background components at or below this pixel count are filled. */
  maxHoleSize: number;
  /** Disconnected foreground components at or below this pixel count are suppressed, unless fine-detail-preserved. */
  maxIslandSize: number;
  /** Alpha value used to binarize the matte into "foreground"/"background" for component labeling. */
  binarizeThreshold: number;
  /** Fraction of an island's own pixels that must be fine-detail-flagged for it to be preserved instead of suppressed. */
  fineDetailOverlapThreshold: number;
}

export const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  maxHoleSize: 24,
  maxIslandSize: 24,
  binarizeThreshold: 0.5,
  fineDetailOverlapThreshold: 0.2,
};

export interface CleanupResult {
  alpha: Float32Array;
  holesFilled: number;
  islandsRemoved: number;
  islandsPreserved: number;
  /** Count of disconnected foreground components still present AFTER island suppression/preservation above — i.e. how many separate pieces the surviving matte is split into. 1 means one coherent shape (the common, healthy case); a large count means the output is fragmented even after cleanup removed the tiny noise-sized specks. Free to compute — `labelConnectedComponents` already ran for island cleanup above; this just counts what's left. */
  remainingComponentCount: number;
}

export function cleanupHolesAndIslands(
  alpha: Float32Array,
  width: number,
  height: number,
  fineDetailMask: Uint8Array | null,
  options: CleanupOptions = DEFAULT_CLEANUP_OPTIONS,
): CleanupResult {
  const out = alpha.slice();
  const n = width * height;

  const foregroundMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) foregroundMask[i] = alpha[i] > options.binarizeThreshold ? 1 : 0;

  // --- Small-hole cleanup: enclosed background components -> filled opaque. ---
  const backgroundMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) backgroundMask[i] = 1 - foregroundMask[i];
  const backgroundComponents = labelConnectedComponents(backgroundMask, width, height);

  let holesFilled = 0;
  for (let label = 0; label < backgroundComponents.sizes.length; label++) {
    if (backgroundComponents.touchesBorder[label]) continue; // the real exterior background, not a hole
    if (backgroundComponents.sizes[label] > options.maxHoleSize) continue;
    for (const i of backgroundComponents.pixelsByLabel[label]) out[i] = 1;
    holesFilled++;
  }

  // --- Small-island cleanup: disconnected foreground components -> suppressed, unless fine-detail-preserved. ---
  const foregroundComponents = labelConnectedComponents(foregroundMask, width, height);

  let islandsRemoved = 0;
  let islandsPreserved = 0;
  for (let label = 0; label < foregroundComponents.sizes.length; label++) {
    const size = foregroundComponents.sizes[label];
    if (size > options.maxIslandSize) continue;

    const pixels = foregroundComponents.pixelsByLabel[label];
    let detailCount = 0;
    if (fineDetailMask) {
      for (const i of pixels) if (fineDetailMask[i]) detailCount++;
    }
    const detailFraction = pixels.length > 0 ? detailCount / pixels.length : 0;

    if (detailFraction >= options.fineDetailOverlapThreshold) {
      islandsPreserved++;
      continue;
    }

    for (const i of pixels) out[i] = 0;
    islandsRemoved++;
  }

  const remainingComponentCount = foregroundComponents.sizes.length - islandsRemoved;

  return { alpha: out, holesFilled, islandsRemoved, islandsPreserved, remainingComponentCount };
}
