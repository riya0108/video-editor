import { computeStrokeCoverage, type Point, type BrushStampOptions } from "./brush-stamp";
import { boxBlur, guidedFilterAlpha } from "../guided-filter";

/**
 * MANUAL MATTE REFINEMENT — Phase 6. Lets a user correct AI matting
 * mistakes by hand without ever touching the AI's own output.
 *
 * Non-destructive by construction, not just convention: `baseAlpha` (the
 * AI-computed matte) is defensively copied on construction and never
 * written to by any method here. Every manual edit instead lives in a
 * sparse overlay — `touched`/`overrideAlpha` — and the alpha a caller
 * actually renders (`getEffectiveAlpha`) is computed per-pixel as
 * `touched[i] ? overrideAlpha[i] : baseAlpha[i]`. "Reset local refinement"
 * and "Restore" are therefore always exact and instant: there is no lossy
 * history to replay, just a flag to clear.
 *
 * Every mutating method (`applyStroke`, `undo`, `redo`, `reset`) returns the
 * DirtyRegion it touched — a bounding box, not the whole canvas — so a
 * caller only needs to recomposite/redraw that rectangle. Brush cost itself
 * scales with the stroke's own extent (brush-stamp.ts allocates a
 * bounding-box-sized buffer, never a full-image one). Together these are
 * the concrete answer to "do not require the entire image to be recomputed
 * after every brush stroke."
 */
export const enum BrushMode {
  /** Pushes touched pixels toward fully opaque (alpha 1). */
  Foreground = 0,
  /** Pushes touched pixels toward fully transparent (alpha 0). */
  Background = 1,
  /** Reruns a local guided-filter pass (same algorithm as edge-refine.ts/guided-filter.ts) within the brush footprint, using the *current* effective alpha and the source image as guidance — a manual "try refining this specific spot again" tool. */
  RefineEdge = 2,
  /**
   * Gradually blends the manual override back toward the underlying AI
   * alpha, scaled by brush opacity — a "soft undo" a user can dab
   * repeatedly to partially back out an overzealous edit, distinct from...
   */
  Eraser = 3,
  /**
   * ...Restore, which discards the override outright wherever the brush
   * touches (opacity-independent — only the brush's spatial footprint,
   * size/hardness/feather, shapes it) — a decisive, one-stroke "just give
   * me the AI's original answer back here" tool.
   */
  Restore = 4,
}

export interface BrushOptions extends BrushStampOptions {
  /** 0..1 — how strongly one stroke moves affected pixels toward the brush's target value. <1 lets repeated strokes build up gradually, same as an ordinary paint tool. Ignored by Restore (see BrushMode.Restore's doc comment). */
  opacity: number;
  /** Additional local smoothing radius (image pixels) applied within the stroke's own dirty region right after painting — 0 = none. A distinct concept from `hardness` (which shapes one stamp) — this softens the *result* of the whole stroke. */
  feather: number;
}

export const DEFAULT_BRUSH_OPTIONS: BrushOptions = {
  size: 24,
  hardness: 0.7,
  opacity: 1,
  feather: 0,
};

export interface DirtyRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface RegionSnapshot {
  touched: Uint8Array;
  overrideAlpha: Float32Array;
}

interface HistoryEntry {
  region: DirtyRegion;
  snapshot: RegionSnapshot;
}

export interface SerializedManualRefinementLayer {
  width: number;
  height: number;
  baseAlpha: number[];
  touched: number[];
  overrideAlpha: number[];
}

function regionWidth(r: DirtyRegion): number {
  return r.maxX - r.minX + 1;
}
function regionHeight(r: DirtyRegion): number {
  return r.maxY - r.minY + 1;
}

export class ManualRefinementEngine {
  readonly width: number;
  readonly height: number;
  private baseAlpha: Float32Array;
  private touched: Uint8Array;
  private overrideAlpha: Float32Array;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly maxHistory: number;

  constructor(baseAlpha: Float32Array, width: number, height: number, maxHistory = 200) {
    if (baseAlpha.length !== width * height) throw new Error("baseAlpha length must equal width*height");
    this.baseAlpha = baseAlpha.slice(); // defensive copy — this class never mutates a caller's array
    this.width = width;
    this.height = height;
    this.touched = new Uint8Array(width * height);
    this.overrideAlpha = new Float32Array(width * height);
    this.maxHistory = maxHistory;
  }

  /** The alpha a caller should actually render: the manual override wherever painted, the untouched AI output everywhere else. Always a fresh array — never an internal reference a caller could accidentally mutate. */
  getEffectiveAlpha(): Float32Array {
    const out = new Float32Array(this.width * this.height);
    for (let i = 0; i < out.length; i++) out[i] = this.touched[i] ? this.overrideAlpha[i] : this.baseAlpha[i];
    return out;
  }

  /** The original AI output, completely unaffected by any manual edit — proof the source is never destroyed. */
  getBaseAlpha(): Float32Array {
    return this.baseAlpha.slice();
  }

  hasManualEdits(): boolean {
    return this.touched.some((v) => v !== 0);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private snapshotRegion(region: DirtyRegion): RegionSnapshot {
    const w = regionWidth(region);
    const h = regionHeight(region);
    const touched = new Uint8Array(w * h);
    const overrideAlpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (region.minY + y) * this.width + (region.minX + x);
        const li = y * w + x;
        touched[li] = this.touched[i];
        overrideAlpha[li] = this.overrideAlpha[i];
      }
    }
    return { touched, overrideAlpha };
  }

  private writeRegion(region: DirtyRegion, snapshot: RegionSnapshot): void {
    const w = regionWidth(region);
    const h = regionHeight(region);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (region.minY + y) * this.width + (region.minX + x);
        const li = y * w + x;
        this.touched[i] = snapshot.touched[li];
        this.overrideAlpha[i] = snapshot.overrideAlpha[li];
      }
    }
  }

  private pushHistory(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Applies one brush stroke. `path` is a sequence of image-space points
   * (a mouse/touch drag, already in image pixel coordinates — see
   * viewport.ts for screen<->image conversion). `rgba` is required for
   * RefineEdge (it needs the source image as guidance) and ignored by every
   * other mode. Returns the DirtyRegion actually touched, or null for an
   * empty/off-canvas stroke (nothing changed, nothing to undo).
   */
  applyStroke(path: Point[], mode: BrushMode, brushOverrides: Partial<BrushOptions> = {}, rgba?: Uint8ClampedArray): DirtyRegion | null {
    const options: BrushOptions = { ...DEFAULT_BRUSH_OPTIONS, ...brushOverrides };
    const stroke = computeStrokeCoverage(path, this.width, this.height, options);
    if (!stroke) return null;

    const region: DirtyRegion = { minX: stroke.minX, minY: stroke.minY, maxX: stroke.maxX, maxY: stroke.maxY };
    // Feathering can spread alpha slightly beyond the stroke's own painted
    // footprint (that's the point — a feathered edge is wider than a hard
    // one), so the region snapshotted for undo/returned to the caller has
    // to include that extra margin too, decided up front, before anything
    // is mutated — not discovered after the fact.
    const featherPad = options.feather > 0 ? Math.ceil(options.feather) : 0;
    const finalRegion: DirtyRegion = {
      minX: Math.max(0, region.minX - featherPad),
      minY: Math.max(0, region.minY - featherPad),
      maxX: Math.min(this.width - 1, region.maxX + featherPad),
      maxY: Math.min(this.height - 1, region.maxY + featherPad),
    };
    const before = this.snapshotRegion(finalRegion);

    const opacity = Math.min(1, Math.max(0, options.opacity));
    for (let ly = 0; ly < stroke.height; ly++) {
      for (let lx = 0; lx < stroke.width; lx++) {
        const cov = stroke.coverage[ly * stroke.width + lx];
        if (cov <= 0) continue;
        const gx = stroke.minX + lx;
        const gy = stroke.minY + ly;
        const i = gy * this.width + gx;
        this.applyModeAtPixel(i, mode, cov, opacity);
      }
    }

    if (mode === BrushMode.RefineEdge && rgba) {
      this.applyRefineEdgePass(region, stroke.coverage, stroke.width, opacity, rgba);
    }

    if (options.feather > 0) {
      this.applyLocalFeather(options.feather, finalRegion);
    }

    this.pushHistory({ region: finalRegion, snapshot: before });
    return finalRegion;
  }

  private applyModeAtPixel(i: number, mode: BrushMode, coverage: number, opacity: number): void {
    const current = this.touched[i] ? this.overrideAlpha[i] : this.baseAlpha[i];
    const strength = coverage * opacity;
    switch (mode) {
      case BrushMode.Foreground:
        this.overrideAlpha[i] = current + (1 - current) * strength;
        this.touched[i] = 1;
        return;
      case BrushMode.Background:
        this.overrideAlpha[i] = current + (0 - current) * strength;
        this.touched[i] = 1;
        return;
      case BrushMode.Eraser: {
        const blended = current + (this.baseAlpha[i] - current) * strength;
        if (strength >= 1) {
          this.touched[i] = 0;
          this.overrideAlpha[i] = 0;
        } else {
          this.overrideAlpha[i] = blended;
          this.touched[i] = 1;
        }
        return;
      }
      case BrushMode.Restore:
        // Opacity-independent by design — see BrushMode.Restore's doc comment.
        if (coverage > 0) {
          this.touched[i] = 0;
          this.overrideAlpha[i] = 0;
        }
        return;
      case BrushMode.RefineEdge:
        return; // handled in applyRefineEdgePass, which needs neighbor context a single-pixel loop can't provide
    }
  }

  /** Extracts a padded sub-rectangle of the *effective* alpha (so the filter sees real neighboring context, not a hard crop seam) and the matching rgba, runs the same guided filter used elsewhere in the pipeline, and blends the result back in — shaped by the stroke's own coverage, exactly like every other brush mode. */
  private applyRefineEdgePass(region: DirtyRegion, coverage: Float32Array, coverageWidth: number, opacity: number, rgba: Uint8ClampedArray): void {
    const pad = 3;
    const x0 = Math.max(0, region.minX - pad);
    const y0 = Math.max(0, region.minY - pad);
    const x1 = Math.min(this.width - 1, region.maxX + pad);
    const y1 = Math.min(this.height - 1, region.maxY + pad);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    const subAlpha = new Float32Array(w * h);
    const subRgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gi = (y0 + y) * this.width + (x0 + x);
        const li = y * w + x;
        subAlpha[li] = this.touched[gi] ? this.overrideAlpha[gi] : this.baseAlpha[gi];
        const go = gi * 4;
        const lo = li * 4;
        subRgba[lo] = rgba[go];
        subRgba[lo + 1] = rgba[go + 1];
        subRgba[lo + 2] = rgba[go + 2];
        subRgba[lo + 3] = rgba[go + 3];
      }
    }

    const filtered = guidedFilterAlpha(subAlpha, subRgba, w, h, 2, 1e-4);

    for (let gy = region.minY; gy <= region.maxY; gy++) {
      for (let gx = region.minX; gx <= region.maxX; gx++) {
        const cov = coverage[(gy - region.minY) * coverageWidth + (gx - region.minX)];
        if (cov <= 0) continue;
        const strength = cov * opacity;
        const gi = gy * this.width + gx;
        const li = (gy - y0) * w + (gx - x0);
        const current = this.touched[gi] ? this.overrideAlpha[gi] : this.baseAlpha[gi];
        this.overrideAlpha[gi] = current + (filtered[li] - current) * strength;
        this.touched[gi] = 1;
      }
    }
  }

  /** Post-stroke smoothing, restricted to (a small padding around) the stroke's own region — never the whole image. */
  /**
   * `writeRegion` is deliberately WIDER than `paintedRegion` — a feathered
   * edge is meant to spread alpha slightly beyond the brush's own painted
   * footprint, not just soften what's already inside it. `writeRegion` is
   * exactly the padded box `applyStroke` already snapshotted for undo, so
   * every pixel this method can possibly touch is guaranteed to be covered
   * by that snapshot.
   */
  private applyLocalFeather(radius: number, writeRegion: DirtyRegion): void {
    const x0 = writeRegion.minX;
    const y0 = writeRegion.minY;
    const w = writeRegion.maxX - x0 + 1;
    const h = writeRegion.maxY - y0 + 1;

    const sub = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gi = (y0 + y) * this.width + (x0 + x);
        sub[y * w + x] = this.touched[gi] ? this.overrideAlpha[gi] : this.baseAlpha[gi];
      }
    }
    const blurred = boxBlur(sub, w, h, radius);

    for (let gy = writeRegion.minY; gy <= writeRegion.maxY; gy++) {
      for (let gx = writeRegion.minX; gx <= writeRegion.maxX; gx++) {
        const gi = gy * this.width + gx;
        const li = (gy - y0) * w + (gx - x0);
        this.overrideAlpha[gi] = blurred[li];
        this.touched[gi] = 1;
      }
    }
  }

  /** Undoes the most recent stroke or reset, restoring exactly the region it touched. Returns the affected region, or null if there's nothing to undo. */
  undo(): DirtyRegion | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const current = this.snapshotRegion(entry.region);
    this.writeRegion(entry.region, entry.snapshot);
    this.redoStack.push({ region: entry.region, snapshot: current });
    return entry.region;
  }

  /** Reapplies the most recently undone stroke or reset. Returns the affected region, or null if there's nothing to redo. */
  redo(): DirtyRegion | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const current = this.snapshotRegion(entry.region);
    this.writeRegion(entry.region, entry.snapshot);
    this.undoStack.push({ region: entry.region, snapshot: current });
    return entry.region;
  }

  /** "Reset local refinement": discards every manual edit at once, reverting fully to the AI's own output. Unlike a single stroke, this is a genuine whole-image operation — still undoable, via one full-image history entry rather than pretending it's local. */
  reset(): DirtyRegion {
    const region: DirtyRegion = { minX: 0, minY: 0, maxX: this.width - 1, maxY: this.height - 1 };
    const before = this.snapshotRegion(region);
    this.touched.fill(0);
    this.overrideAlpha.fill(0);
    this.pushHistory({ region, snapshot: before });
    return region;
  }

  /** Serializes the *layer state* (base alpha + manual overlay) — not the undo/redo history, which is a session-only interaction log, not part of the persisted edit. Reloading via `deserialize` reproduces the exact same effective alpha, just with a fresh (empty) undo stack. */
  serialize(): SerializedManualRefinementLayer {
    return {
      width: this.width,
      height: this.height,
      baseAlpha: Array.from(this.baseAlpha),
      touched: Array.from(this.touched),
      overrideAlpha: Array.from(this.overrideAlpha),
    };
  }

  static deserialize(data: SerializedManualRefinementLayer): ManualRefinementEngine {
    const engine = new ManualRefinementEngine(Float32Array.from(data.baseAlpha), data.width, data.height);
    engine.touched = Uint8Array.from(data.touched);
    engine.overrideAlpha = Float32Array.from(data.overrideAlpha);
    return engine;
  }
}
