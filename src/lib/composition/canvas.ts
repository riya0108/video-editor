import type { Ctx2D } from "./draw";

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** OffscreenCanvas where available (works in workers, no DOM node), falling back to a detached <canvas>. */
export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export function get2d(canvas: AnyCanvas): Ctx2D {
  // alpha: true is required — a transparent composition background must survive into the output.
  const ctx = canvas.getContext("2d", { alpha: true }) as Ctx2D | null;
  if (!ctx) throw new Error("2D canvas context unavailable.");
  return ctx;
}

/** Resizes in place only when the size actually changed — assigning width/height (even to the same value) clears the canvas and reallocates its backing store. */
export function ensureSize(canvas: AnyCanvas, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
