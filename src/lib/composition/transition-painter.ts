import type { PaintOp, TransitionPainter, TransitionSide } from "../transitions/registry";
import type { Ctx2D } from "./draw";

const OP_TO_COMPOSITE: Record<PaintOp, GlobalCompositeOperation> = { over: "source-over", add: "lighter", under: "destination-over" };

/**
 * Canvas 2D implementation of TransitionPainter (TRANSITIONS_ARCHITECTURE.md
 * §4). `ctx` is a cleared, frame-sized scratch surface; `from` / `to` are
 * scratch surfaces each holding one fully-rendered layer. Same contract as the
 * software painter used in tests (lib/transitions/software-painter.ts).
 */
export class CanvasTransitionPainter implements TransitionPainter {
  constructor(
    private readonly ctx: Ctx2D,
    private readonly from: Ctx2D | null,
    private readonly to: Ctx2D | null,
    readonly renderScale: number,
  ) {}

  get width() {
    return this.ctx.canvas.width;
  }

  get height() {
    return this.ctx.canvas.height;
  }

  get hasFrom() {
    return this.from !== null;
  }

  get hasTo() {
    return this.to !== null;
  }

  draw(side: TransitionSide, opts: { alpha?: number; offsetX?: number; offsetY?: number; scale?: number; originX?: number; originY?: number; op?: PaintOp } = {}): void {
    const src = side === "from" ? this.from : this.to;
    const alpha = Math.min(1, Math.max(0, opts.alpha ?? 1));
    if (!src || alpha <= 0) return;
    const s = opts.scale ?? 1;
    const ox = opts.originX ?? this.width / 2;
    const oy = opts.originY ?? this.height / 2;
    const c = this.ctx;
    c.setTransform(s, 0, 0, s, ox - s * ox + (opts.offsetX ?? 0), oy - s * oy + (opts.offsetY ?? 0));
    c.globalAlpha = alpha;
    c.globalCompositeOperation = OP_TO_COMPOSITE[opts.op ?? "over"];
    c.drawImage(src.canvas, 0, 0);
    this.reset();
  }

  fill(color: string, alpha: number, op: "over" | "atop" = "over"): void {
    const a = Math.min(1, Math.max(0, alpha));
    if (a <= 0) return;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = a;
    c.globalCompositeOperation = op === "atop" ? "source-atop" : "source-over";
    c.fillStyle = color;
    c.fillRect(0, 0, this.width, this.height);
    this.reset();
  }

  maskLinear(axis: "x" | "y", from: number, to: number): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    // A zero-length gradient paints nothing; nudge it so a hard edge still masks (1 on the `from` side).
    const end = from === to ? to + 1e-3 : to;
    const g = axis === "x" ? c.createLinearGradient(from, 0, end, 0) : c.createLinearGradient(0, from, 0, end);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.globalCompositeOperation = "destination-in";
    c.fillStyle = g;
    c.fillRect(0, 0, this.width, this.height);
    this.reset();
  }

  mixPixels(fn: (from: Uint8ClampedArray | null, to: Uint8ClampedArray | null, out: Uint8ClampedArray, width: number, height: number) => void): void {
    const { width: w, height: h } = this;
    const a = this.from ? this.from.getImageData(0, 0, w, h).data : null;
    const b = this.to ? this.to.getImageData(0, 0, w, h).data : null;
    const out = this.ctx.createImageData(w, h);
    fn(a, b, out.data, w, h);
    this.ctx.putImageData(out, 0, 0);
  }

  private reset() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
  }
}
