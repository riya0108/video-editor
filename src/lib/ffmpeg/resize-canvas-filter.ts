import { parseHexColor } from "../color";
import { resolveBackgroundSize, type EditorBackgroundState } from "./editor-state";

export { resolveBackgroundSize };
/** Same shape the full Video Editor's "Resize for a platform" panel uses — reused as-is so every tool that adopts this feature shares one settings shape, one filter builder, and one UI component. */
export type ResizeCanvasSettings = EditorBackgroundState;

export const DEFAULT_RESIZE_SETTINGS: ResizeCanvasSettings = {
  enabled: false,
  presetId: "custom",
  customWidth: 1080,
  customHeight: 1920,
  fillMode: "blur",
  solidColor: "#000000",
  gradientFrom: "#6366f1",
  gradientTo: "#22d3ee",
  gradientDirection: "vertical",
};

/**
 * Fits `vLabel` onto a new target canvas (a social-preset or custom size) and
 * fills the empty letterbox/pillarbox space — a blurred zoomed copy of the
 * source, a solid color, or a two-color gradient. Extracted from the full
 * Video Editor's export pipeline (`build-editor-command.ts`) so every
 * single-purpose tool can offer the same "resize for a platform" behavior
 * without re-deriving the filtergraph. Caller owns the actual `-i`/`-f lavfi
 * -i` input list and `filters` array — this only appends to them, the same
 * closure-based builder pattern bg-removal-command.ts and
 * build-editor-command.ts already use.
 */
export function applyResizeCanvas({
  vLabel,
  filters,
  addLavfiInput,
  newLabel,
  settings,
  durationSeconds,
}: {
  vLabel: string;
  filters: string[];
  addLavfiInput: (source: string, preArgs?: string[]) => number;
  newLabel: (prefix: "v") => string;
  settings: ResizeCanvasSettings;
  durationSeconds: number;
}): { vLabel: string; width: number; height: number } {
  const { w: targetW, h: targetH } = resolveBackgroundSize(settings);
  const durArg = (Math.max(0, durationSeconds) + 1).toFixed(2);

  let bgLabel: string;
  let fgSource = vLabel;
  if (settings.fillMode === "solid") {
    const idx = addLavfiInput(`color=c=${settings.solidColor.replace("#", "0x")}:s=${targetW}x${targetH}:d=${durArg}`);
    bgLabel = `${idx}:v`;
  } else if (settings.fillMode === "gradient") {
    const from = parseHexColor(settings.gradientFrom);
    const to = parseHexColor(settings.gradientTo);
    const t =
      settings.gradientDirection === "horizontal"
        ? "(X/W)"
        : settings.gradientDirection === "diagonal"
          ? "((X+Y)/(W+H))"
          : "(Y/H)";
    const expr = (c1: number, c2: number) => `${c1}+(${c2}-${c1})*${t}`;
    const idx = addLavfiInput(`color=c=black:s=${targetW}x${targetH}:d=${durArg}`);
    const gradOut = newLabel("v");
    filters.push(`[${idx}:v]geq=r='${expr(from.r, to.r)}':g='${expr(from.g, to.g)}':b='${expr(from.b, to.b)}'[${gradOut}]`);
    bgLabel = gradOut;
  } else {
    const split1 = newLabel("v");
    const split2 = newLabel("v");
    filters.push(`[${vLabel}]split=2[${split1}][${split2}]`);
    const blurOut = newLabel("v");
    // Blurring at full target resolution with a wide kernel is prohibitively
    // slow in this single-threaded wasm build (measured: minutes instead of
    // seconds at 1080x1920). Blur destroys fine detail anyway, so blurring a
    // small downscaled copy and scaling back up looks visually identical at
    // a fraction of the compute — same trick every real-time blur
    // implementation uses.
    const smallW = Math.max(2, Math.round(targetW / 6 / 2) * 2);
    const smallH = Math.max(2, Math.round(targetH / 6 / 2) * 2);
    filters.push(
      `[${split1}]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},scale=${smallW}:${smallH},avgblur=sizeX=8:sizeY=8,scale=${targetW}:${targetH}[${blurOut}]`,
    );
    bgLabel = blurOut;
    fgSource = split2;
  }

  const fgOut = newLabel("v");
  filters.push(`[${fgSource}]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[${fgOut}]`);
  const composited = newLabel("v");
  filters.push(`[${bgLabel}][${fgOut}]overlay=(W-w)/2:(H-h)/2[${composited}]`);

  // The solid/gradient background is intentionally built 1s longer than the
  // real content (durArg above) so it can't end a frame early and truncate
  // the foreground — but since it's the overlay's primary/bottom layer,
  // that extra second otherwise leaks straight into the exported file's
  // duration as a trailing frozen frame. Capping it back down here (a no-op
  // for "blur", whose background is derived from the content itself and
  // already matches exactly) keeps `applyResizeCanvas` duration-neutral for
  // every caller instead of each one having to know to re-bound it.
  const trimmed = newLabel("v");
  filters.push(`[${composited}]trim=duration=${durationSeconds}[${trimmed}]`);

  return { vLabel: trimmed, width: targetW, height: targetH };
}
