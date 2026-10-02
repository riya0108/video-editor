import { applyVisualPatch, type ClipVisual } from "../timeline/visual";
import { patchTextStyle, scaleTypography, type TextStyle, type TextStylePatch } from "../timeline/text-style";
import type { ClipEdit } from "../timeline/operations";
import { layoutText, type TextMeasurer } from "../composition/text-layout";
import { boxToComp, isCornerHandle, resizeFromHandle, type BoxSize, type HandleId } from "../composition/transform-tools";
import type { Point } from "../composition/matrix";

/**
 * TEXT-AWARE RESIZE (TEXT_ENGINE_ARCHITECTURE.md §5). Reuses the generic
 * Phase 5 handle math (resizeFromHandle) — no second transform system — and
 * only changes what the result MEANS for text, so glyphs are never stretched:
 *
 *  - e/w (side) handles -> box mode, new boxWidth: the text re-wraps.
 *  - n/s handles        -> box mode, new boxHeight (fixed height box).
 *  - corner handles     -> typography scales (fontSize, spacing, padding,
 *                          stroke, shadow, radius, box dims) by one factor.
 *
 * The transform's scale is left untouched in every case. Because re-wrapping
 * changes the box height, the layout is recomputed and the position re-solved
 * so the edge/corner OPPOSITE the dragged handle stays exactly where it was
 * (or the anchor, with fromAnchor).
 */

const HANDLE_UV: Record<HandleId, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};
const OPPOSITE: Record<HandleId, HandleId> = { nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e" };

/** Which normalized box point stays fixed: the opposite corner; for side handles the opposite side's TOP (so re-wrapping grows downward); for n/s the opposite side's middle. */
function pinnedUV(handle: HandleId): [number, number] {
  const [u, v] = HANDLE_UV[OPPOSITE[handle]];
  if (handle === "e" || handle === "w") return [u, 0];
  return [u, v];
}

export interface TextResizeInput {
  text: string;
  style: TextStyle;
  visual: ClipVisual;
  /** Current laid-out box (composition px). */
  box: BoxSize;
  handle: HandleId;
  pointer: Point;
  /** Shift: corners free / sides keep aspect is meaningless for text, so Shift on a corner is ignored; fromAnchor = Alt. */
  fromAnchor: boolean;
  measurer: TextMeasurer;
}

export interface TextResizeResult {
  edit: Required<ClipEdit>;
  style: TextStyle;
  visual: ClipVisual;
  box: BoxSize;
}

export function textResize(input: TextResizeInput): TextResizeResult {
  const { style, visual, box, handle } = input;
  // Generic math on the current box: tells us the size ratio the gesture asks for.
  const generic = resizeFromHandle(visual, box, handle, input.pointer, { keepAspect: isCornerHandle(handle), fromAnchor: input.fromAnchor });
  const rx = generic.transform.scaleX / visual.transform.scaleX;
  const ry = generic.transform.scaleY / visual.transform.scaleY;

  let patch: TextStylePatch;
  if (isCornerHandle(handle)) {
    const k = Math.max(0.01, rx);
    patch = scaleTypography(style, k);
  } else if (handle === "e" || handle === "w") {
    patch = { sizing: "box", boxWidth: Math.max(style.fontSize * 0.5 + style.padding * 2, box.width * rx) };
  } else {
    patch = { sizing: "box", boxWidth: style.boxWidth ?? box.width, boxHeight: Math.max(1, box.height * ry) };
  }
  const nextStyle = patchTextStyle(style, patch);
  const layout = layoutText(input.text, nextStyle, input.measurer);
  const nextBox = { width: layout.width, height: layout.height };

  // Re-solve position so the pinned point doesn't move: keep the anchor NORMALIZED, find where the pinned box point lands, and shift.
  const [pu, pv] = input.fromAnchor ? [visual.transform.anchorX, visual.transform.anchorY] : pinnedUV(handle);
  const before = boxToComp(visual, box, { x: pu * box.width, y: pv * box.height });
  const unshifted = boxToComp(visual, nextBox, { x: pu * nextBox.width, y: pv * nextBox.height });
  const nextVisual = applyVisualPatch(visual, { transform: { x: visual.transform.x + (before.x - unshifted.x), y: visual.transform.y + (before.y - unshifted.y) } });

  return {
    edit: { content: { textStyle: nextStyle }, visual: { transform: { x: nextVisual.transform.x, y: nextVisual.transform.y } } },
    style: nextStyle,
    visual: nextVisual,
    box: nextBox,
  };
}
