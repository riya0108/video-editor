import { normalizeAlpha } from "./normalize";
import { buildTrimap, buildFineDetailMask, type TrimapOptions, type FineDetailOptions, DEFAULT_TRIMAP_OPTIONS, DEFAULT_FINE_DETAIL_OPTIONS } from "./trimap";
import { cleanupHolesAndIslands, type CleanupOptions, DEFAULT_CLEANUP_OPTIONS } from "./cleanup";
import { smoothAlpha, featherAlpha, antiAliasAlpha, type SmoothOptions } from "./smoothing-ops";
import { contractExpandAlpha, shiftEdgeAlpha } from "./shape-ops";
import { applyAlphaContrast } from "./contrast";
import { refineEdgeBand, DEFAULT_EDGE_REFINE_OPTIONS, type EdgeRefineOptions } from "../edge-refine";

/**
 * The internal API for Phase 2 ("ALPHA MATTE REFINEMENT"). Every operation
 * listed in the brief is represented here as an explicit, independently
 * tunable parameter group — "expose refinement parameters through an
 * internal API" — but `remove-background.ts` (the only current caller)
 * only ever overrides `smooth`, matching "do not expose every technical
 * parameter in the UI yet": nothing here is wired to a UI control.
 *
 * Every field has a documented no-op value (0 for the "creative" shaping
 * operations — contractExpand, shiftEdge, contrast, feather — since those
 * are tools a caller opts into, not corrections applied unconditionally)
 * so a caller can override just the one thing they care about via a
 * partial params object (see mergeParams).
 */
export interface RefinementParams {
  trimap: TrimapOptions;
  fineDetail: FineDetailOptions;
  cleanup: CleanupOptions;
  /** Edge-aware smoothing (guided filter, unknown-band only). */
  smooth: SmoothOptions;
  /** A second, smaller-radius, more targeted pass — see edge-refine.ts. */
  localEdgeRefine: EdgeRefineOptions;
  antiAlias: { radius: number };
  /** 0 = no-op. */
  contractExpand: { amount: number };
  /** 0 = no-op. */
  shiftEdge: { bias: number };
  /** 0 = no-op. */
  contrast: { amount: number };
  /** 0 = no-op. */
  feather: { radius: number };
}

export const DEFAULT_REFINEMENT_PARAMS: RefinementParams = {
  trimap: DEFAULT_TRIMAP_OPTIONS,
  fineDetail: DEFAULT_FINE_DETAIL_OPTIONS,
  cleanup: DEFAULT_CLEANUP_OPTIONS,
  smooth: { radius: 2, eps: 1e-3 },
  localEdgeRefine: DEFAULT_EDGE_REFINE_OPTIONS,
  antiAlias: { radius: 1 },
  contractExpand: { amount: 0 },
  shiftEdge: { bias: 0 },
  contrast: { amount: 0 },
  feather: { radius: 0 },
};

export type PartialRefinementParams = { [K in keyof RefinementParams]?: Partial<RefinementParams[K]> };

function mergeParams(defaults: RefinementParams, overrides: PartialRefinementParams): RefinementParams {
  return {
    trimap: { ...defaults.trimap, ...overrides.trimap },
    fineDetail: { ...defaults.fineDetail, ...overrides.fineDetail },
    cleanup: { ...defaults.cleanup, ...overrides.cleanup },
    smooth: { ...defaults.smooth, ...overrides.smooth },
    localEdgeRefine: { ...defaults.localEdgeRefine, ...overrides.localEdgeRefine },
    antiAlias: { ...defaults.antiAlias, ...overrides.antiAlias },
    contractExpand: { ...defaults.contractExpand, ...overrides.contractExpand },
    shiftEdge: { ...defaults.shiftEdge, ...overrides.shiftEdge },
    contrast: { ...defaults.contrast, ...overrides.contrast },
    feather: { ...defaults.feather, ...overrides.feather },
  };
}

export interface RefineAlphaMatteResult {
  alpha: Float32Array;
  trimap: Uint8Array;
  fineDetailMask: Uint8Array;
  holesFilled: number;
  islandsRemoved: number;
  islandsPreserved: number;
}

/**
 * Runs the full Phase 2 pipeline: normalize -> trimap -> fine-detail mask ->
 * hole/island cleanup -> edge-aware smoothing -> local edge refinement ->
 * anti-aliasing -> (optional) contract/expand -> (optional) shift edge ->
 * (optional) contrast -> (optional) feather. The four "optional" steps are
 * genuine no-ops at their default params — they exist as tunable tools for
 * a future UI/caller, not because every image needs them.
 *
 * Every step returns a *new* array — nothing here mutates `alpha` or `rgba`,
 * satisfying "keep all operations non-destructive" structurally, not just
 * by convention.
 */
export function refineAlphaMatte(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  overrides: PartialRefinementParams = {},
): RefineAlphaMatteResult {
  const params = mergeParams(DEFAULT_REFINEMENT_PARAMS, overrides);

  let a = normalizeAlpha(alpha);

  // Fine-detail classification depends only on the source image, not on
  // alpha/trimap (see buildFineDetailMask's doc comment for why) — compute
  // it once, up front.
  const fineDetailMask = buildFineDetailMask(rgba, width, height, params.fineDetail);

  const cleanup = cleanupHolesAndIslands(a, width, height, fineDetailMask, params.cleanup);
  a = cleanup.alpha;

  // Trimap is built on the cleaned-up alpha (after holes are filled and
  // islands suppressed), so every unknown-band-restricted step below sees
  // an accurate classification.
  const trimap = buildTrimap(a, width, height, params.trimap);

  a = smoothAlpha(a, rgba, width, height, trimap, params.smooth);
  a = refineEdgeBand(a, rgba, width, height, params.localEdgeRefine);
  a = antiAliasAlpha(a, width, height, trimap, params.antiAlias.radius);

  if (params.contractExpand.amount !== 0) a = contractExpandAlpha(a, width, height, params.contractExpand.amount);
  if (params.shiftEdge.bias !== 0) a = shiftEdgeAlpha(a, params.shiftEdge.bias);
  if (params.contrast.amount !== 0) a = applyAlphaContrast(a, trimap, params.contrast.amount);
  if (params.feather.radius > 0) a = featherAlpha(a, width, height, trimap, params.feather.radius);

  return {
    alpha: a,
    trimap,
    fineDetailMask,
    holesFilled: cleanup.holesFilled,
    islandsRemoved: cleanup.islandsRemoved,
    islandsPreserved: cleanup.islandsPreserved,
  };
}
