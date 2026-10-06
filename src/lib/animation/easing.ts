/**
 * INTERPOLATION / EASING (KEYFRAME_ENGINE_ARCHITECTURE.md §4).
 *
 * An easing maps normalized segment time t ∈ [0,1] to eased progress. Types
 * live in a registry so new curves (custom curves, spring...) are one
 * `registerEasing` call — the evaluator, persistence and UI don't change.
 * ease-in / ease-out / ease-in-out are the CSS-standard cubic-Béziers, so
 * arbitrary Bézier curves are supported by the same solver.
 */

export type EasingSpec =
  | { type: "linear" }
  | { type: "ease-in" }
  | { type: "ease-out" }
  | { type: "ease-in-out" }
  /** Step: hold the start value until the next keyframe. */
  | { type: "hold" }
  | { type: "cubic-bezier"; x1: number; y1: number; x2: number; y2: number };

export type EasingType = EasingSpec["type"];
export type EasingFn = (t: number) => number;

/** Cubic-Bézier timing function through (0,0), (x1,y1), (x2,y2), (1,1) — the CSS model. x1/x2 must be in [0,1] so x(t) is monotonic. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solveU = (x: number): number => {
    // Newton-Raphson, then bisection if the slope is too flat to trust.
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - x;
      if (Math.abs(err) < 1e-7) return u;
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(u);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solveU(t)));
}

const registry = new Map<string, (spec: EasingSpec) => EasingFn>();

/** Extension point: register a new easing type (custom curve, spring, ...). */
export function registerEasing<T extends EasingSpec["type"] | string>(type: T, factory: (spec: EasingSpec) => EasingFn): void {
  registry.set(type, factory);
}

registerEasing("linear", () => (t) => t);
registerEasing("hold", () => (t) => (t >= 1 ? 1 : 0));
registerEasing("ease-in", () => cubicBezier(0.42, 0, 1, 1));
registerEasing("ease-out", () => cubicBezier(0, 0, 0.58, 1));
registerEasing("ease-in-out", () => cubicBezier(0.42, 0, 0.58, 1));
registerEasing("cubic-bezier", (s) => {
  const b = s as Extract<EasingSpec, { type: "cubic-bezier" }>;
  return cubicBezier(b.x1, b.y1, b.x2, b.y2);
});

const fnCache = new Map<string, EasingFn>();

export function easingFn(spec: EasingSpec): EasingFn {
  const key = JSON.stringify(spec);
  let fn = fnCache.get(key);
  if (!fn) {
    const factory = registry.get(spec.type) ?? registry.get("linear")!;
    fn = factory(spec);
    if (fnCache.size > 256) fnCache.clear();
    fnCache.set(key, fn);
  }
  return fn;
}

export const EASING_PRESETS: readonly { type: Exclude<EasingType, "cubic-bezier">; label: string }[] = [
  { type: "linear", label: "Linear" },
  { type: "ease-in", label: "Ease in" },
  { type: "ease-out", label: "Ease out" },
  { type: "ease-in-out", label: "Ease in-out" },
  { type: "hold", label: "Hold" },
];

/** Validates an easing from untrusted data (project files). */
export function normalizeEasing(raw: unknown): EasingSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "linear":
    case "ease-in":
    case "ease-out":
    case "ease-in-out":
    case "hold":
      return { type: r.type };
    case "cubic-bezier": {
      const n = [r.x1, r.y1, r.x2, r.y2];
      if (!n.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
      const [x1, y1, x2, y2] = n as number[];
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
      return { type: "cubic-bezier", x1, y1, x2, y2 };
    }
    default:
      return null;
  }
}
