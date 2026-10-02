import { applyVisualPatch, normalizeCrop, type ClipVisual, type CropInsets } from "../timeline/visual";
import type { Point, Rect } from "./matrix";

/**
 * TRANSFORM TOOLS — pure math behind every interactive transform (on-canvas
 * handles, keyboard, numeric fields). Each function maps (start visual,
 * gesture) -> new visual; nothing here touches pixels.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: a transform is only ever a change to the
 * numbers in ClipVisual. The renderer re-draws the ORIGINAL source through
 * one matrix every frame — media is resampled exactly once, from the source,
 * and text and shapes are re-rasterized as vectors at the output scale. No
 * gesture reads back a previously rendered/transformed raster, so scaling
 * down then up again (or rotating 37° 100 times) never compounds any loss.
 *
 * BOX SPACE: the layer's fitted box in composition px before the user
 * transform, origin at its top-left (u in [0, box.width] x [0, box.height]).
 * A box point maps to composition space as
 *     p = pos + R(rotation) . S(scaleX*flipX, scaleY*flipY) . (u - anchor*box)
 * which is exactly layerMatrix() in resolve.ts with the content->box scale
 * factored out.
 */

export interface BoxSize {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.01;

const rad = (deg: number) => (deg * Math.PI) / 180;

function signedScale(v: ClipVisual): { sx: number; sy: number } {
  const t = v.transform;
  return { sx: t.scaleX * (t.flipX ? -1 : 1), sy: t.scaleY * (t.flipY ? -1 : 1) };
}

function rotate(p: Point, deg: number): Point {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function boxToComp(v: ClipVisual, box: BoxSize, u: Point): Point {
  const t = v.transform;
  const { sx, sy } = signedScale(v);
  const r = rotate({ x: sx * (u.x - t.anchorX * box.width), y: sy * (u.y - t.anchorY * box.height) }, t.rotation);
  return { x: t.x + r.x, y: t.y + r.y };
}

export function compToBox(v: ClipVisual, box: BoxSize, p: Point): Point {
  const t = v.transform;
  const { sx, sy } = signedScale(v);
  const r = rotate({ x: p.x - t.x, y: p.y - t.y }, -t.rotation);
  return { x: r.x / sx + t.anchorX * box.width, y: r.y / sy + t.anchorY * box.height };
}

/** On-screen size of the (uncropped) layer: box x scale. This is what the W/H fields show and edit. */
export function layerSize(v: ClipVisual, box: BoxSize): BoxSize {
  return { width: box.width * v.transform.scaleX, height: box.height * v.transform.scaleY };
}

/**
 * Width/height edit, about the anchor (the anchor stays put on screen).
 * Implemented as a scale change — the source is never resized.
 * `keepAspect` derives the other dimension from the one given.
 */
export function setLayerSize(v: ClipVisual, box: BoxSize, size: Partial<BoxSize>, keepAspect: boolean): ClipVisual {
  let scaleX = v.transform.scaleX;
  let scaleY = v.transform.scaleY;
  if (size.width !== undefined) scaleX = size.width / box.width;
  if (size.height !== undefined) scaleY = size.height / box.height;
  if (keepAspect) {
    const ratio = v.transform.scaleY / v.transform.scaleX;
    if (size.width !== undefined && size.height === undefined) scaleY = scaleX * ratio;
    else if (size.height !== undefined && size.width === undefined) scaleX = scaleY / ratio;
  }
  return applyVisualPatch(v, { transform: { scaleX: Math.max(MIN_SCALE, scaleX), scaleY: Math.max(MIN_SCALE, scaleY) } });
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLE_IDS: readonly HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const HANDLE_UV: Record<HandleId, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

const OPPOSITE: Record<HandleId, HandleId> = { nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e" };

export function isCornerHandle(h: HandleId): boolean {
  return h.length === 2;
}

/** The visible (cropped) rect in box space — handles sit on what the user actually sees, not on cropped-away area. */
export function visibleBoxRect(v: ClipVisual, box: BoxSize): Rect {
  const c = v.crop;
  return { x: c.left * box.width, y: c.top * box.height, width: box.width * (1 - c.left - c.right), height: box.height * (1 - c.top - c.bottom) };
}

/** Uncropped box rect — what crop handles edit against. */
export function fullBoxRect(box: BoxSize): Rect {
  return { x: 0, y: 0, width: box.width, height: box.height };
}

export function handleBoxPoint(rect: Rect, h: HandleId): Point {
  const [u, w] = HANDLE_UV[h];
  return { x: rect.x + rect.width * u, y: rect.y + rect.height * w };
}

export function handleCompPoints(v: ClipVisual, box: BoxSize, rect: Rect = visibleBoxRect(v, box)): Record<HandleId, Point> {
  const out = {} as Record<HandleId, Point>;
  for (const h of HANDLE_IDS) out[h] = boxToComp(v, box, handleBoxPoint(rect, h));
  return out;
}

/**
 * CSS resize cursor for a handle, accounting for the layer's rotation and
 * flips (a north handle on a layer rotated 90° drags horizontally).
 */
export function handleCursor(v: ClipVisual, box: BoxSize, h: HandleId): string {
  const rect = visibleBoxRect(v, box);
  const center = boxToComp(v, box, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const p = boxToComp(v, box, handleBoxPoint(rect, h));
  const angle = ((Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 360) % 180;
  const cursors = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  return cursors[Math.round(angle / 45) % 4];
}

export interface ResizeOptions {
  /** Scale both axes by the same factor. */
  keepAspect: boolean;
  /** Scale about the anchor point instead of the opposite handle. */
  fromAnchor: boolean;
}

/**
 * Handle-drag resize. The OPPOSITE handle (or the anchor, with fromAnchor)
 * stays fixed on screen; the dragged handle follows the pointer along the
 * layer's own (rotated) axes. Implemented purely as scale + position changes.
 * Dragging past the fixed point clamps at MIN_SCALE rather than inverting —
 * mirroring is an explicit flip, never a gesture side-effect.
 */
export function resizeFromHandle(start: ClipVisual, box: BoxSize, handle: HandleId, pointer: Point, opts: ResizeOptions): ClipVisual {
  const t = start.transform;
  const rect = visibleBoxRect(start, box);
  const uH = handleBoxPoint(rect, handle);
  const uF = opts.fromAnchor ? { x: t.anchorX * box.width, y: t.anchorY * box.height } : handleBoxPoint(rect, OPPOSITE[handle]);
  const pF = boxToComp(start, box, uF);
  const { sx, sy } = signedScale(start);

  // Pointer relative to the fixed point, in the layer's rotated frame.
  const v = rotate({ x: pointer.x - pF.x, y: pointer.y - pF.y }, -t.rotation);
  const hx = uH.x - uF.x;
  const hy = uH.y - uF.y;
  const movesX = Math.abs(hx) > 1e-9;
  const movesY = Math.abs(hy) > 1e-9;

  // Ratio new/old along each axis the handle controls.
  let rx = movesX ? v.x / (sx * hx) : 1;
  let ry = movesY ? v.y / (sy * hy) : 1;

  if (opts.keepAspect) {
    let r: number;
    if (movesX && movesY) {
      // Project the pointer onto the handle's diagonal: smooth, and independent of which axis the pointer happens to lead on.
      const dx = sx * hx;
      const dy = sy * hy;
      r = (v.x * dx + v.y * dy) / (dx * dx + dy * dy);
    } else {
      r = movesX ? rx : ry;
    }
    rx = r;
    ry = r;
  }

  const scaleX = Math.max(MIN_SCALE, t.scaleX * rx);
  const scaleY = Math.max(MIN_SCALE, t.scaleY * ry);
  const resized = applyVisualPatch(start, { transform: { scaleX, scaleY } });
  // Re-pin the fixed point: pos' = pF - R.S'.(uF - anchor)
  const drift = boxToComp(resized, box, uF);
  return applyVisualPatch(resized, { transform: { x: resized.transform.x + (pF.x - drift.x), y: resized.transform.y + (pF.y - drift.y) } });
}

/** Rotation handle: rotates about the anchor by the angle the pointer swept around it. `snapStep` (degrees) quantizes the result, e.g. 15 with Shift. */
export function rotateFromPointer(start: ClipVisual, startPointer: Point, pointer: Point, snapStep?: number): ClipVisual {
  const t = start.transform;
  const a0 = Math.atan2(startPointer.y - t.y, startPointer.x - t.x);
  const a1 = Math.atan2(pointer.y - t.y, pointer.x - t.x);
  let rotation = t.rotation + ((a1 - a0) * 180) / Math.PI;
  if (snapStep) rotation = Math.round(rotation / snapStep) * snapStep;
  return applyVisualPatch(start, { transform: { rotation: normalizeAngle(rotation) } });
}

/** (-180, 180] — keeps the stored value readable instead of drifting to 1437°. */
export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Object.is(a, -0) ? 0 : a;
}

/**
 * Moves the anchor point to `p` (composition px) WITHOUT moving the layer:
 * anchor and position change together so every pixel stays where it was.
 * Only future rotation/scale pivot differently.
 */
export function moveAnchorTo(start: ClipVisual, box: BoxSize, p: Point): ClipVisual {
  const u = compToBox(start, box, p);
  return applyVisualPatch(start, { transform: { anchorX: u.x / box.width, anchorY: u.y / box.height, x: p.x, y: p.y } });
}

/** Anchor set from normalized box coordinates (e.g. the 9-point anchor grid), also without moving the layer. */
export function setAnchorNormalized(start: ClipVisual, box: BoxSize, anchorX: number, anchorY: number): ClipVisual {
  return moveAnchorTo(start, box, boxToComp(start, box, { x: anchorX * box.width, y: anchorY * box.height }));
}

/** The 9 canonical anchor points (corners, edge midpoints, center), normalized — the anchor snaps to these when dragged near. */
export const ANCHOR_PRESETS: readonly [number, number][] = [
  [0, 0], [0.5, 0], [1, 0],
  [0, 0.5], [0.5, 0.5], [1, 0.5],
  [0, 1], [0.5, 1], [1, 1],
];

/**
 * Crop-mode handle drag: the dragged edge(s) follow the pointer in box
 * space; the layer itself never moves or rescales (crop is in-place).
 */
export function cropFromHandle(start: ClipVisual, box: BoxSize, handle: HandleId, pointer: Point): ClipVisual {
  const u = compToBox(start, box, pointer);
  const fx = u.x / box.width;
  const fy = u.y / box.height;
  const next: CropInsets = { ...start.crop };
  if (handle.includes("w")) next.left = fx;
  if (handle.includes("e")) next.right = 1 - fx;
  if (handle.includes("n")) next.top = fy;
  if (handle.includes("s")) next.bottom = 1 - fy;
  // Keep the edge being dragged from pushing the opposite edge (normalizeCrop would split the difference between both).
  const clamped: CropInsets = {
    left: handle.includes("w") ? Math.min(Math.max(0, next.left), 0.99 - next.right) : next.left,
    right: handle.includes("e") ? Math.min(Math.max(0, next.right), 0.99 - next.left) : next.right,
    top: handle.includes("n") ? Math.min(Math.max(0, next.top), 0.99 - next.bottom) : next.top,
    bottom: handle.includes("s") ? Math.min(Math.max(0, next.bottom), 0.99 - next.top) : next.bottom,
  };
  return applyVisualPatch(start, { crop: normalizeCrop(clamped) });
}

/** Composition-space axis-aligned bounds of the visible region — what alignment and snapping operate on. */
export function visibleBounds(v: ClipVisual, box: BoxSize): Rect {
  const r = visibleBoxRect(v, box);
  const pts = [
    boxToComp(v, box, { x: r.x, y: r.y }),
    boxToComp(v, box, { x: r.x + r.width, y: r.y }),
    boxToComp(v, box, { x: r.x + r.width, y: r.y + r.height }),
    boxToComp(v, box, { x: r.x, y: r.y + r.height }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Translate by a composition-px delta. */
export function translateVisual(v: ClipVisual, dx: number, dy: number): ClipVisual {
  return applyVisualPatch(v, { transform: { x: v.transform.x + dx, y: v.transform.y + dy } });
}
