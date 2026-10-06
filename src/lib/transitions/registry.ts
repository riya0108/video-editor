/**
 * TRANSITION REGISTRY (TRANSITIONS_ARCHITECTURE.md §3). A transition type is
 * DATA + a compositor written against the TransitionPainter interface — never
 * against Canvas 2D directly. The renderer supplies a painter (Canvas 2D in
 * the app, a pure software painter in tests); adding a type is one
 * `registerTransition` call, with no change to the resolver, renderer,
 * persistence or UI (they're all driven by this registry).
 *
 * Custom / mask transitions plug in here too: a luma/mask wipe is a
 * compositor that uses `painter.mixPixels` (per-pixel access to both sides)
 * or a future painter primitive; nothing else changes.
 */

export type TransitionDirection = "left" | "right" | "up" | "down" | "in" | "out";

export type TransitionParamDef =
  | { key: string; label: string; kind: "number"; min: number; max: number; step: number; default: number; unit: "" | "%" | "px" | "x" }
  | { key: string; label: string; kind: "color"; default: string };

export type TransitionParams = Record<string, number | string>;

/** Which surface a draw refers to: the outgoing clip (A) or the incoming clip (B). Either may be absent (timeline/clip boundary). */
export type TransitionSide = "from" | "to";

/** Compositing op for a surface draw. over = source-over, add = additive (exact linear mix of two weighted layers), under = behind what's already there. */
export type PaintOp = "over" | "add" | "under";

/**
 * Renderer-agnostic drawing surface for a transition. All coordinates are in
 * render pixels of the frame; both sides are full-frame surfaces with the
 * layer already drawn (transform, matte, effects and opacity applied). The
 * painter starts empty (transparent); its result is composited onto the frame
 * at the track's z-position.
 */
export interface TransitionPainter {
  readonly width: number;
  readonly height: number;
  /** Render pixels per composition pixel (preview < 1). Spatial params are in composition px x this. */
  readonly renderScale: number;
  readonly hasFrom: boolean;
  readonly hasTo: boolean;
  /** Draws one side, optionally translated and/or scaled about (originX, originY) (default: frame center). No-op if the side is absent. */
  draw(side: TransitionSide, opts?: { alpha?: number; offsetX?: number; offsetY?: number; scale?: number; originX?: number; originY?: number; op?: PaintOp }): void;
  /** Solid color. op "atop" paints only where something is already drawn (keeps the alpha) — a dip-to-color that respects the layer's shape. */
  fill(color: string, alpha: number, op?: "over" | "atop"): void;
  /** Multiplies everything drawn so far by a linear ramp along `axis`: 1 at `from`, 0 at `to` (render px; from > to reverses it; from === to is a hard edge). */
  maskLinear(axis: "x" | "y", from: number, to: number): void;
  /** Per-pixel compositing: unpremultiplied RGBA bytes of each side (null if absent) -> `out` (starts transparent). For dissolves, mask/luma transitions. */
  mixPixels(fn: (from: Uint8ClampedArray | null, to: Uint8ClampedArray | null, out: Uint8ClampedArray, width: number, height: number) => void): void;
}

export interface TransitionRenderArgs {
  /** Eased progress, 0 = all outgoing, 1 = all incoming. */
  progress: number;
  params: TransitionParams;
  direction?: TransitionDirection;
  /** True between two clips; false at a clip/timeline boundary (one side absent). */
  paired: boolean;
  /** Deterministic seed for noise-based types (stable across preview/export and scrubbing). */
  seed: number;
}

export interface TransitionDefinition {
  type: string;
  label: string;
  description: string;
  params: TransitionParamDef[];
  /** Allowed directions (first = default); absent = the type has no direction. */
  directions?: TransitionDirection[];
  /** Default duration in seconds. */
  defaultSeconds: number;
  render(painter: TransitionPainter, args: TransitionRenderArgs): void;
}

const registry = new Map<string, TransitionDefinition>();

/** Extension point: add (or replace) a transition type. */
export function registerTransition(def: TransitionDefinition): void {
  registry.set(def.type, def);
}

export function getTransitionDefinition(type: string): TransitionDefinition | undefined {
  return registry.get(type);
}

export function isTransitionType(type: unknown): type is string {
  return typeof type === "string" && registry.has(type);
}

export function listTransitionDefinitions(): TransitionDefinition[] {
  return [...registry.values()];
}

/** Unit vector of a movement direction (screen space: +y is down). */
export function directionVector(dir: TransitionDirection | undefined): { x: number; y: number } {
  switch (dir) {
    case "left":
      return { x: -1, y: 0 };
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    case "right":
    default:
      return { x: 1, y: 0 };
  }
}

const MOVE_DIRECTIONS: TransitionDirection[] = ["left", "right", "up", "down"];

/** Deterministic hash noise in [0, 1) on an integer lattice. */
export function hashNoise(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const num = (params: TransitionParams, key: string, fallback: number) => (typeof params[key] === "number" ? (params[key] as number) : fallback);

// ---------------------------------------------------------------------------
// BUILT-IN TYPES
// ---------------------------------------------------------------------------

registerTransition({
  type: "cut",
  label: "Cut",
  description: "Hard switch at the midpoint — an explicit straight cut.",
  params: [],
  defaultSeconds: 0.5,
  render(p, { progress }) {
    p.draw(progress < 0.5 ? "from" : "to");
  },
});

registerTransition({
  type: "fade",
  label: "Fade",
  description: "Between clips: dips through a color. At a clip's start/end: fades the clip in/out.",
  params: [{ key: "color", label: "Color", kind: "color", default: "#000000" }],
  defaultSeconds: 1,
  render(p, { progress, params, paired }) {
    if (!paired) {
      // Boundary: the clip itself fades (to transparency — what's below shows through).
      if (p.hasFrom) p.draw("from", { alpha: 1 - progress });
      else p.draw("to", { alpha: progress });
      return;
    }
    const color = typeof params.color === "string" ? params.color : "#000000";
    if (progress < 0.5) {
      p.draw("from");
      p.fill(color, progress * 2, "atop");
    } else {
      p.draw("to");
      p.fill(color, (1 - progress) * 2, "atop");
    }
  },
});

registerTransition({
  type: "dissolve",
  label: "Dissolve",
  description: "Granular (dither) dissolve: pixels switch to the incoming clip in a random pattern.",
  params: [{ key: "grain", label: "Grain size", kind: "number", min: 1, max: 64, step: 1, default: 2, unit: "px" }],
  defaultSeconds: 1,
  render(p, { progress, params, seed }) {
    const k = 1 / p.renderScale;
    const grain = Math.max(1, num(params, "grain", 2));
    p.mixPixels((a, b, out, w, h) => {
      for (let y = 0; y < h; y++) {
        // Lattice anchored in COMPOSITION space, so preview (any scale) and export dissolve the same pattern.
        const gy = Math.floor((y + 0.5) * k / grain);
        for (let x = 0; x < w; x++) {
          const gx = Math.floor((x + 0.5) * k / grain);
          const src = hashNoise(gx, gy, seed) < progress ? b : a;
          const i = (y * w + x) * 4;
          if (src) {
            out[i] = src[i];
            out[i + 1] = src[i + 1];
            out[i + 2] = src[i + 2];
            out[i + 3] = src[i + 3];
          }
        }
      }
    });
  },
});

registerTransition({
  type: "cross-dissolve",
  label: "Cross dissolve",
  description: "Smooth linear blend from the outgoing to the incoming clip.",
  params: [],
  defaultSeconds: 1,
  render(p, { progress }) {
    // Weighted sum A·(1-p) + B·p (premultiplied, additive) — exact for transparent layers too, no mid-point dip.
    p.draw("from", { alpha: 1 - progress });
    p.draw("to", { alpha: progress, op: "add" });
  },
});

registerTransition({
  type: "slide",
  label: "Slide",
  description: "The incoming clip slides in over the outgoing one (at a clip's end: the clip slides out).",
  params: [],
  directions: MOVE_DIRECTIONS,
  defaultSeconds: 0.75,
  render(p, { progress, direction, paired }) {
    const v = directionVector(direction);
    if (!paired && p.hasFrom) {
      p.draw("from", { offsetX: v.x * p.width * progress, offsetY: v.y * p.height * progress });
      return;
    }
    p.draw("from");
    p.draw("to", { offsetX: -v.x * p.width * (1 - progress), offsetY: -v.y * p.height * (1 - progress) });
  },
});

registerTransition({
  type: "push",
  label: "Push",
  description: "The incoming clip pushes the outgoing one off the frame.",
  params: [],
  directions: MOVE_DIRECTIONS,
  defaultSeconds: 0.75,
  render(p, { progress, direction }) {
    const v = directionVector(direction);
    p.draw("from", { offsetX: v.x * p.width * progress, offsetY: v.y * p.height * progress });
    p.draw("to", { offsetX: -v.x * p.width * (1 - progress), offsetY: -v.y * p.height * (1 - progress) });
  },
});

registerTransition({
  type: "wipe",
  label: "Wipe",
  description: "A moving edge reveals the incoming clip.",
  params: [{ key: "softness", label: "Edge softness", kind: "number", min: 0, max: 0.5, step: 0.01, default: 0.05, unit: "%" }],
  directions: MOVE_DIRECTIONS,
  defaultSeconds: 1,
  render(p, { progress, direction, params }) {
    const dir = direction ?? "right";
    const horizontal = dir === "left" || dir === "right";
    const len = horizontal ? p.width : p.height;
    // At least 1 render px of ramp: an antialiased edge, and the ramp's orientation (which side is revealed) is always defined.
    const feather = Math.max(1, Math.max(0, num(params, "softness", 0.05)) * len);
    // Edge position along the travel axis, measured from where the wipe starts; it travels -feather/2 .. len+feather/2 so p=0 is all A and p=1 all B.
    const pos = -feather / 2 + progress * (len + feather);
    const forward = dir === "right" || dir === "down";
    // Incoming side first, masked to the revealed region; the outgoing side goes UNDER it.
    p.draw("to");
    if (forward) p.maskLinear(horizontal ? "x" : "y", pos - feather / 2, pos + feather / 2);
    else p.maskLinear(horizontal ? "x" : "y", len - pos + feather / 2, len - pos - feather / 2);
    p.draw("from", { op: "under" });
  },
});

registerTransition({
  type: "zoom",
  label: "Zoom",
  description: "Cross-zoom: the outgoing clip zooms away while the incoming one zooms into place.",
  params: [{ key: "amount", label: "Zoom amount", kind: "number", min: 1.1, max: 6, step: 0.1, default: 2, unit: "x" }],
  directions: ["in", "out"],
  defaultSeconds: 1,
  render(p, { progress, direction, params }) {
    const z = Math.max(1.0001, num(params, "amount", 2));
    const zin = direction !== "out";
    // "in": A grows 1 -> z, B grows 1/z -> 1. "out": A shrinks 1 -> 1/z, B shrinks z -> 1. Log-space so the motion reads as constant speed.
    const a = zin ? Math.pow(z, progress) : Math.pow(z, -progress);
    const b = zin ? Math.pow(z, progress - 1) : Math.pow(z, 1 - progress);
    p.draw("from", { scale: a, alpha: 1 - progress });
    p.draw("to", { scale: b, alpha: progress, op: "add" });
  },
});
