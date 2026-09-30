import { useEffect, useRef, useState, useCallback } from "react";
import { drawSourceToRgba, type MattingResult } from "../matting/pipeline";
import {
  ManualRefinementEngine,
  BrushMode,
  MattePreviewEngine,
  PreviewBackgroundMode,
  HairRefinementEngine,
  ColourDecontaminationEngine,
  buildTrimap,
  DEFAULT_TRIMAP_OPTIONS,
  type PreviewOptions,
  type PreviewBuffer,
  type Point,
} from "../matting/pipeline/refine";

/** UI-facing brush names — kept separate from Phase 6's BrushMode enum so the component layer never has to import/expose that enum's numeric values directly. */
export type BrushKind = "foreground" | "background" | "refine-edge" | "eraser" | "restore";

const BRUSH_KIND_TO_MODE: Record<BrushKind, BrushMode> = {
  foreground: BrushMode.Foreground,
  background: BrushMode.Background,
  "refine-edge": BrushMode.RefineEdge,
  eraser: BrushMode.Eraser,
  restore: BrushMode.Restore,
};

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  feather: number;
}

const DEFAULT_BRUSH_SETTINGS: BrushSettings = { size: 32, hardness: 0.7, opacity: 1, feather: 0 };

/**
 * PHASE 12 — BACKGROUND REMOVAL UI. The REFINE step's engine wiring: holds a
 * Phase 6 ManualRefinementEngine (non-destructive brush edits over the
 * matte useAiImageMatte.ts already generated) and a Phase 11
 * MattePreviewEngine (cheap re-compositing across background modes). No
 * method here can re-run the AI model — there is no model reference
 * anywhere in this file.
 */
export function useMatteRefinement(sourceImg: HTMLImageElement | null, matting: MattingResult | null) {
  const engineRef = useRef<ManualRefinementEngine | null>(null);
  const previewEngineRef = useRef<MattePreviewEngine | null>(null);
  const rgbaRef = useRef<Uint8ClampedArray | null>(null);
  const dimsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  const [previewBuffer, setPreviewBuffer] = useState<PreviewBuffer | null>(null);
  const [backgroundMode, setBackgroundModeState] = useState<PreviewBackgroundMode>(PreviewBackgroundMode.Checkerboard);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [hasEdits, setHasEdits] = useState(false);
  const [brushKind, setBrushKind] = useState<BrushKind>("foreground");
  const [brush, setBrush] = useState<BrushSettings>(DEFAULT_BRUSH_SETTINGS);

  useEffect(() => {
    if (!sourceImg || !matting) {
      engineRef.current = null;
      previewEngineRef.current = null;
      rgbaRef.current = null;
      setPreviewBuffer(null);
      setCanUndo(false);
      setCanRedo(false);
      setHasEdits(false);
      return;
    }
    const { alpha, alphaWidth, alphaHeight } = matting;
    const rgba = drawSourceToRgba(sourceImg, alphaWidth, alphaHeight);
    rgbaRef.current = rgba;
    dimsRef.current = { width: alphaWidth, height: alphaHeight };
    engineRef.current = new ManualRefinementEngine(alpha, alphaWidth, alphaHeight);
    previewEngineRef.current = new MattePreviewEngine({ alpha, rgba, width: alphaWidth, height: alphaHeight });
    setBackgroundModeState(PreviewBackgroundMode.Checkerboard);
    setPreviewBuffer(previewEngineRef.current.render(PreviewBackgroundMode.Checkerboard));
    setCanUndo(false);
    setCanRedo(false);
    setHasEdits(false);
  }, [sourceImg, matting]);

  const syncAfterEdit = useCallback(
    (mode: PreviewBackgroundMode = backgroundMode, options?: Partial<PreviewOptions>) => {
      const engine = engineRef.current;
      const previewEngine = previewEngineRef.current;
      const rgba = rgbaRef.current;
      if (!engine || !previewEngine || !rgba) return;
      const { width, height } = dimsRef.current;
      previewEngine.updateMatte({ alpha: engine.getEffectiveAlpha(), rgba, width, height });
      setCanUndo(engine.canUndo());
      setCanRedo(engine.canRedo());
      setHasEdits(engine.hasManualEdits());
      setPreviewBuffer(previewEngine.render(mode, options));
    },
    [backgroundMode],
  );

  const paintStroke = useCallback(
    (points: Point[]) => {
      const engine = engineRef.current;
      const rgba = rgbaRef.current;
      if (!engine || points.length === 0) return;
      engine.applyStroke(points, BRUSH_KIND_TO_MODE[brushKind], brush, rgba ?? undefined);
      syncAfterEdit();
    },
    [brushKind, brush, syncAfterEdit],
  );

  const undo = useCallback(() => {
    engineRef.current?.undo();
    syncAfterEdit();
  }, [syncAfterEdit]);

  const redo = useCallback(() => {
    engineRef.current?.redo();
    syncAfterEdit();
  }, [syncAfterEdit]);

  const resetEdits = useCallback(() => {
    engineRef.current?.reset();
    syncAfterEdit();
  }, [syncAfterEdit]);

  const setBackgroundMode = useCallback(
    (mode: PreviewBackgroundMode, options?: Partial<PreviewOptions>) => {
      setBackgroundModeState(mode);
      const previewEngine = previewEngineRef.current;
      if (previewEngine) setPreviewBuffer(previewEngine.render(mode, options));
    },
    [],
  );

  /** One-shot: reruns Phase 3's HairRefinementEngine over the CURRENT effective alpha (not the model — no inference here) and adopts the result as a fresh base. Discards prior brush edits (a new engine is created), same as clicking Reset would — the button is meant to be used early, before manual touch-ups, not interleaved with them. */
  const enhanceHair = useCallback(() => {
    const engine = engineRef.current;
    const rgba = rgbaRef.current;
    if (!engine || !rgba) return;
    const { width, height } = dimsRef.current;
    const alpha = engine.getEffectiveAlpha();
    const trimap = buildTrimap(alpha, width, height, DEFAULT_TRIMAP_OPTIONS);
    const result = new HairRefinementEngine().refine(alpha, rgba, width, height, trimap);
    engineRef.current = new ManualRefinementEngine(result.alpha, width, height);
    syncAfterEdit();
  }, [syncAfterEdit]);

  /** One-shot: reruns Phase 4's ColourDecontaminationEngine over the current alpha/colour — corrects colour only (alpha is read-only to it), so the working rgba is updated too. Same "discards prior brush edits" caveat as enhanceHair. */
  const reduceColorSpill = useCallback(() => {
    const engine = engineRef.current;
    const rgba = rgbaRef.current;
    if (!engine || !rgba) return;
    const { width, height } = dimsRef.current;
    const alpha = engine.getEffectiveAlpha();
    const trimap = buildTrimap(alpha, width, height, DEFAULT_TRIMAP_OPTIONS);
    const result = new ColourDecontaminationEngine().process(rgba, alpha, width, height, trimap);
    rgbaRef.current = result.rgba;
    engineRef.current = new ManualRefinementEngine(alpha, width, height);
    syncAfterEdit();
  }, [syncAfterEdit]);

  const getFinalAlpha = useCallback((): Float32Array | null => engineRef.current?.getEffectiveAlpha() ?? null, []);
  const getWorkingRgba = useCallback((): Uint8ClampedArray | null => rgbaRef.current, []);

  return {
    previewBuffer,
    backgroundMode,
    setBackgroundMode,
    brushKind,
    setBrushKind,
    brush,
    setBrush,
    paintStroke,
    undo,
    redo,
    resetEdits,
    canUndo,
    canRedo,
    hasEdits,
    enhanceHair,
    reduceColorSpill,
    getFinalAlpha,
    getWorkingRgba,
  };
}
