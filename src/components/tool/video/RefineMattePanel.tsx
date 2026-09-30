import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eraser, Image as ImageIcon, Paintbrush, RotateCcw, Redo2, Sparkles, SprayCan, Undo2, Wand2 } from "lucide-react";
import ToolPanelSection from "../ToolPanelSection";
import { useMatteRefinement, type BrushKind } from "../../../lib/hooks/useMatteRefinement";
import { PreviewBackgroundMode, type Point } from "../../../lib/matting/pipeline/refine";
import { mapPointIntoContainedCanvas } from "../../../lib/matting/pipeline/refine/contain-point-mapping";
import type { MattingResult } from "../../../lib/matting/pipeline";

/**
 * PHASE 12 — BACKGROUND REMOVAL UI. The REFINE step of the
 * IMPORT -> SELECT MEDIA -> REMOVE BACKGROUND -> AI PROCESSING -> RESULT ->
 * REFINE -> PREVIEW -> APPLY -> CONTINUE EDITING flow, for still images in
 * AI mode. Chroma-key mode and video skip straight from AI PROCESSING/RESULT
 * to export today, unchanged — see useAiImageMatte.ts's doc comment for why.
 *
 * Progressive disclosure: the default, always-visible controls are just
 * "paint to add/remove" plus a brush-size slider and four common preview
 * backgrounds — no ML terms anywhere in that surface. Brush hardness/
 * opacity/feather, the Refine-edge/Eraser/Restore tools, the remaining five
 * preview modes, and the one-click hair/colour-spill passes all live under
 * one collapsed "Advanced" section (ToolPanelSection defaultOpen={false}).
 */

const SIMPLE_BACKGROUNDS: { mode: PreviewBackgroundMode; label: string }[] = [
  { mode: PreviewBackgroundMode.Checkerboard, label: "Transparent" },
  { mode: PreviewBackgroundMode.Black, label: "Black" },
  { mode: PreviewBackgroundMode.White, label: "White" },
  { mode: PreviewBackgroundMode.Original, label: "Original" },
];

const ADVANCED_BACKGROUNDS: { mode: PreviewBackgroundMode; label: string }[] = [
  { mode: PreviewBackgroundMode.Gray, label: "Gray" },
  { mode: PreviewBackgroundMode.HighContrastDiagnostic, label: "High contrast" },
  { mode: PreviewBackgroundMode.MatteOnly, label: "Matte only" },
  { mode: PreviewBackgroundMode.AlphaVisualization, label: "Alpha heatmap" },
];

const SIMPLE_BRUSHES: { kind: BrushKind; label: string; icon: typeof Paintbrush }[] = [
  { kind: "foreground", label: "Add", icon: Paintbrush },
  { kind: "background", label: "Remove", icon: Eraser },
];

const ADVANCED_BRUSHES: { kind: BrushKind; label: string; icon: typeof Paintbrush }[] = [
  { kind: "refine-edge", label: "Refine edge", icon: Sparkles },
  { kind: "eraser", label: "Soften edit", icon: SprayCan },
  { kind: "restore", label: "Restore original", icon: RotateCcw },
];

// PRODUCTION READINESS (H2): see contain-point-mapping.ts's doc comment —
// the canvas is styled `object-contain` with a `max-h` cap, so a portrait
// image/video gets letterboxed inside its box, and getBoundingClientRect()
// alone (as this used to use directly) describes the full box, not the
// visible content, silently mispositioning every brush stroke on exactly
// those images.
function toImagePoint(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  return mapPointIntoContainedCanvas(e.clientX, e.clientY, rect, canvas);
}

export default function RefineMattePanel({
  sourceImg,
  matting,
  onApply,
  onCancel,
}: {
  sourceImg: HTMLImageElement;
  matting: MattingResult;
  onApply: (finalAlpha: Float32Array, workingRgba: Uint8ClampedArray) => void;
  onCancel: () => void;
}) {
  const refinement = useMatteRefinement(sourceImg, matting);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<Point[]>([]);
  const isPaintingRef = useRef(false);
  const [showBefore, setShowBefore] = useState(false);
  const beforeAfterPrevMode = useRef(refinement.backgroundMode);

  // Draw the current preview buffer whenever it changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const buffer = refinement.previewBuffer;
    if (!canvas || !buffer) return;
    if (canvas.width !== buffer.width) canvas.width = buffer.width;
    if (canvas.height !== buffer.height) canvas.height = buffer.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer.rgba), buffer.width, buffer.height), 0, 0);
  }, [refinement.previewBuffer]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isPaintingRef.current = true;
    pathRef.current = [toImagePoint(e, canvas)];
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !isPaintingRef.current) return;
    pathRef.current.push(toImagePoint(e, canvas));
  }, []);

  const commitStroke = useCallback(() => {
    if (!isPaintingRef.current) return;
    isPaintingRef.current = false;
    const path = pathRef.current;
    pathRef.current = [];
    if (path.length > 0) refinement.paintStroke(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refinement.paintStroke]);

  const showOriginal = () => {
    if (showBefore) return;
    beforeAfterPrevMode.current = refinement.backgroundMode;
    refinement.setBackgroundMode(PreviewBackgroundMode.Original);
    setShowBefore(true);
  };
  const showResult = () => {
    if (!showBefore) return;
    refinement.setBackgroundMode(beforeAfterPrevMode.current);
    setShowBefore(false);
  };

  const needsAttention = matting.warnings.length > 0 || matting.confidence < 0.5;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-3">
        {needsAttention && (
          <div className="rounded-lg border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-body-sm">
            <p className="font-medium text-warning-600">AI confidence: {(matting.confidence * 100).toFixed(0)}%</p>
            {matting.warnings.map((w, i) => (
              <p key={i} className="mt-1 text-caption text-(--color-text-muted)">
                {w}
              </p>
            ))}
          </div>
        )}

        <div className="overflow-hidden rounded-lg bg-checkerboard">
          <canvas
            ref={canvasRef}
            className="max-h-[32rem] w-full touch-none object-contain"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={commitStroke}
            onPointerCancel={commitStroke}
            onPointerLeave={commitStroke}
          />
        </div>

        <button
          type="button"
          onPointerDown={showOriginal}
          onPointerUp={showResult}
          onPointerLeave={showResult}
          onPointerCancel={showResult}
          className="inline-flex touch-none items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium select-none hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
        >
          {showBefore ? "Showing original — release to compare" : "Press & hold to see original"}
        </button>
      </div>

      <div className="space-y-4">
        <ToolPanelSection icon={Wand2} label="Touch up">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {SIMPLE_BRUSHES.map(({ kind, label, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => refinement.setBrushKind(kind)}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-caption font-medium transition-colors ${
                    refinement.brushKind === kind
                      ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                      : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              Brush size
              <input
                type="range"
                min={4}
                max={150}
                step={1}
                value={refinement.brush.size}
                onChange={(e) => refinement.setBrush((b) => ({ ...b, size: Number(e.target.value) }))}
                className="w-full accent-(--color-primary-500)"
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!refinement.canUndo}
                onClick={refinement.undo}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 size={14} />
                Undo
              </button>
              <button
                type="button"
                disabled={!refinement.canRedo}
                onClick={refinement.redo}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Redo2 size={14} />
                Redo
              </button>
              <button
                type="button"
                disabled={!refinement.hasEdits}
                onClick={refinement.resetEdits}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reset
              </button>
            </div>
          </div>
        </ToolPanelSection>

        <ToolPanelSection icon={ImageIcon} label="Preview background">
          <div className="grid grid-cols-2 gap-2">
            {SIMPLE_BACKGROUNDS.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                onClick={() => refinement.setBackgroundMode(mode)}
                className={`rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
                  refinement.backgroundMode === mode && !showBefore
                    ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                    : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </ToolPanelSection>

        <ToolPanelSection icon={Sparkles} label="Advanced" defaultOpen={false}>
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-caption font-medium text-(--color-text-muted)">More tools</p>
              <div className="grid grid-cols-1 gap-2">
                {ADVANCED_BRUSHES.map(({ kind, label, icon: Icon }) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => refinement.setBrushKind(kind)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
                      refinement.brushKind === kind
                        ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                        : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                Hardness
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={refinement.brush.hardness}
                  onChange={(e) => refinement.setBrush((b) => ({ ...b, hardness: Number(e.target.value) }))}
                  className="w-full accent-(--color-primary-500)"
                />
              </label>
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                Opacity
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={refinement.brush.opacity}
                  onChange={(e) => refinement.setBrush((b) => ({ ...b, opacity: Number(e.target.value) }))}
                  className="w-full accent-(--color-primary-500)"
                />
              </label>
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                Feather
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={1}
                  value={refinement.brush.feather}
                  onChange={(e) => refinement.setBrush((b) => ({ ...b, feather: Number(e.target.value) }))}
                  className="w-full accent-(--color-primary-500)"
                />
              </label>
            </div>

            <div>
              <p className="mb-2 text-caption font-medium text-(--color-text-muted)">More preview backgrounds</p>
              <div className="grid grid-cols-2 gap-2">
                {ADVANCED_BACKGROUNDS.map(({ mode, label }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => refinement.setBackgroundMode(mode)}
                    className={`rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
                      refinement.backgroundMode === mode && !showBefore
                        ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                        : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-caption font-medium text-(--color-text-muted)">One-click fixes</p>
              <button
                type="button"
                disabled={refinement.hasEdits}
                title={refinement.hasEdits ? "Apply this before your own touch-ups, or Reset first" : undefined}
                onClick={refinement.enhanceHair}
                className="inline-flex w-full items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles size={14} />
                Enhance fine hair detail
              </button>
              <button
                type="button"
                disabled={refinement.hasEdits}
                title={refinement.hasEdits ? "Apply this before your own touch-ups, or Reset first" : undefined}
                onClick={refinement.reduceColorSpill}
                className="inline-flex w-full items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SprayCan size={14} />
                Reduce background color spill
              </button>
              <p className="text-caption text-(--color-text-muted)">
                Model used: {matting.modelUsed} — {(matting.processingTimeMs / 1000).toFixed(1)}s
              </p>
            </div>
          </div>
        </ToolPanelSection>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-(--color-border) px-4 py-2.5 text-body-sm font-semibold hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              const alpha = refinement.getFinalAlpha();
              const rgba = refinement.getWorkingRgba();
              if (alpha && rgba) onApply(alpha, rgba);
            }}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary-500 px-4 py-2.5 text-body-sm font-semibold text-white hover:bg-primary-600"
          >
            <Check size={16} />
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
