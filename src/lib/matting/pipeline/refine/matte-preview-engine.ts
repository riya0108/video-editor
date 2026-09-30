import {
  compositePreview,
  renderEdgePreview,
  type PreviewOptions,
  type PreviewBuffer,
  type EdgePreviewOptions,
  type PreviewBackgroundMode,
} from "./preview-compositor";
import type { DirtyRegion } from "./manual-refinement-engine";

/**
 * MATTE PREVIEW SYSTEM — Phase 11. MattePreviewEngine holds ONE already-
 * generated matte (the output of this app's model + refinement pipeline,
 * Phases 1-10 — or a Phase 6 manual edit) and lets a caller render it under
 * any of preview-compositor.ts's 9 background modes, in any order, any
 * number of times, without ever touching a model.
 *
 * "Separate MATTE GENERATION from COMPOSITING": this class has no
 * constructor parameter, field, method, or import that could invoke a
 * model — it is structurally impossible for `render()` to trigger
 * inference, not just conventionally discouraged. Generation happens
 * entirely OUTSIDE this class; `updateMatte` is the only way its stored
 * matte ever changes, and nothing else on this class calls it.
 *
 * "A generated matte should be reusable across multiple background
 * previews" / "do not re-run the ML model when only the preview background
 * changes": the SAME stored matte backs every `render()` call, across every
 * mode, until `updateMatte` is explicitly called with a new one — see
 * matte-preview-engine.test.ts's "never regenerates" test, which counts a
 * fake generator's own calls directly.
 *
 * "The preview must update efficiently": repeated calls with the same mode/
 * options/region against the same matte are served from a one-entry cache
 * instead of recompositing — see `getStats().cacheHitCount`. The cache key
 * deliberately never stringifies pixel data itself (that would be slower
 * than just recompositing) — it tracks the matte by an internal version
 * counter instead, bumped only by `updateMatte`. One documented consequence:
 * swapping `options.customBackgroundImage` for a same-length-but-different
 * image between two calls with everything else unchanged isn't detected by
 * the cache key and would incorrectly return the stale result — call
 * `render` with a differently-shaped image (or invalidate some other way)
 * if that specific case matters to a caller; the common path this cache is
 * built for is switching between the 9 named modes on a stable matte.
 */

export interface GeneratedMatte {
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface MattePreviewStats {
  /** How many times the per-pixel compositing loop actually ran. */
  compositeRunCount: number;
  /** How many render() calls were served from the cache instead. */
  cacheHitCount: number;
}

function cacheKeyOf(mode: PreviewBackgroundMode, options: Partial<PreviewOptions>, region: DirtyRegion | undefined, matteVersion: number): string {
  return JSON.stringify({ mode, options, region, matteVersion }, (_key, val) => {
    if (val instanceof Uint8ClampedArray || val instanceof Float32Array || val instanceof Uint8Array) {
      return `[TypedArray len=${val.length}]`; // never hash pixel content into the key — see class doc comment
    }
    return val;
  });
}

export class MattePreviewEngine {
  private matte: GeneratedMatte;
  private matteVersion = 0;
  private trimap: Uint8Array | null = null;
  private compositeRunCount = 0;
  private cacheHitCount = 0;
  private lastKey: string | null = null;
  private lastResult: PreviewBuffer | null = null;

  constructor(matte: GeneratedMatte) {
    this.matte = matte;
  }

  /** Replaces the underlying matte — e.g. after a genuine model re-run or a Phase 6 manual edit. Every other method on this class leaves it untouched. */
  updateMatte(matte: GeneratedMatte): void {
    this.matte = matte;
    this.matteVersion++;
    this.invalidateCache();
  }

  /** Supplies the trimap renderEdgeDiagnostic needs — computed once by the caller's own pipeline (Phase 2's buildTrimap), never by this class. */
  setTrimap(trimap: Uint8Array): void {
    this.trimap = trimap;
  }

  getMatte(): GeneratedMatte {
    return this.matte;
  }

  getStats(): MattePreviewStats {
    return { compositeRunCount: this.compositeRunCount, cacheHitCount: this.cacheHitCount };
  }

  private invalidateCache(): void {
    this.lastKey = null;
    this.lastResult = null;
  }

  /** Renders one of the 9 background preview modes from the currently stored matte. */
  render(mode: PreviewBackgroundMode, options: Partial<PreviewOptions> = {}, region?: DirtyRegion): PreviewBuffer {
    const key = cacheKeyOf(mode, options, region, this.matteVersion);
    if (key === this.lastKey && this.lastResult) {
      this.cacheHitCount++;
      return this.lastResult;
    }

    const result = compositePreview(this.matte.rgba, this.matte.alpha, this.matte.width, this.matte.height, { ...options, backgroundMode: mode }, region);
    this.compositeRunCount++;
    this.lastKey = key;
    this.lastResult = result;
    return result;
  }

  /** The edge-uncertainty diagnostic view (Phase 6) — requires setTrimap() to have been called first. Not cached (a secondary diagnostic, called far less often than background-mode switches). */
  renderEdgeDiagnostic(options: Partial<EdgePreviewOptions> = {}, region?: DirtyRegion): PreviewBuffer {
    if (!this.trimap) throw new Error("MattePreviewEngine.setTrimap() must be called before renderEdgeDiagnostic()");
    return renderEdgePreview(this.matte.rgba, this.trimap, this.matte.width, this.matte.height, options, region);
  }
}
