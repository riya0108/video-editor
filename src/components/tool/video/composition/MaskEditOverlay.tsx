import { useEffect, useRef, useState } from "react";
import { applyToPoint, invert, multiply, scale, translate, type Matrix2D, type Point, type ResolvedLayer, type ViewportState } from "../../../../lib/composition";
import { contentToMaskBox, maskBoxCorners, maskContentPolygon, maskControlPoints } from "../../../../lib/masks/geometry";
import { simplifyStroke, type Mask, type MaskPatch, type MaskPoint } from "../../../../lib/masks/model";

/**
 * MASK EDIT OVERLAY (MASK_COMPOSITING_ARCHITECTURE.md §8). An SVG over the
 * preview, in screen space: screen = viewport x layer matrix x content.
 *
 *  - Outlines every mask of the selected layer (dashed when disabled).
 *  - The ACTIVE mask gets handles: drag inside to move, corners to resize (in
 *    the mask's own rotated frame, opposite corner fixed), the top knob to
 *    rotate (Shift snaps to 15°), and — for polygon/freeform — each vertex.
 *  - DRAW MODE: polygon = click points (close on the first point / Enter,
 *    Backspace undoes a point, Esc cancels); freeform = drag a stroke
 *    (simplified on release).
 *
 * Nothing commits per pointermove: a gesture previews through `onDraft` (the
 * parent renders it with the same pure op a commit uses) and commits once on
 * release — one undo step, keyframe-aware at the playhead.
 */
export interface MaskEditOverlayProps {
  layer: ResolvedLayer;
  /** All masks of the clip (enabled or not), keyframe-evaluated at the playhead. */
  masks: Mask[];
  activeMaskId: string | null;
  drawing: "polygon" | "freeform" | null;
  viewport: ViewportState;
  accent: string;
  locked: boolean;
  onSelectMask: (maskId: string) => void;
  onDraft: (maskId: string, patch: MaskPatch | null) => void;
  onCommit: (maskId: string, patch: MaskPatch) => void;
  /** Finished drawing: points in normalized LAYER space. */
  onCreatePath: (type: "polygon" | "freeform", layerPoints: MaskPoint[]) => void;
  onCancelDraw: () => void;
}

type Gesture =
  | { kind: "move"; mask: Mask; start: Point }
  | { kind: "corner"; mask: Mask; opposite: Point }
  | { kind: "rotate"; mask: Mask; center: Point }
  | { kind: "vertex"; mask: Mask; index: number }
  | { kind: "stroke"; points: Point[] };

const CLOSE_RADIUS_PX = 9;

/** Pointer capture keeps a drag alive outside the element; it can throw for an inactive pointer id — never let that abort a gesture. */
function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* gesture still works while the pointer stays over the overlay */
  }
}

export default function MaskEditOverlay(p: MaskEditOverlayProps) {
  const { layer, viewport } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const lastPatch = useRef<MaskPatch | null>(null);
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [hover, setHover] = useState<Point | null>(null);

  const W = layer.width;
  const H = layer.height;
  // content -> screen, and back
  const toScreenM: Matrix2D = multiply(multiply(translate(viewport.panX, viewport.panY), scale(viewport.zoom)), layer.matrix);
  const fromScreenM = invert(toScreenM);
  const toScreen = (c: Point) => applyToPoint(toScreenM, c);
  const screenPos = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toContent = (s: Point): Point => (fromScreenM ? applyToPoint(fromScreenM, s) : { x: 0, y: 0 });
  const pathD = (pts: Point[], close = true) => (pts.length ? `M${pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("L")}${close ? "Z" : ""}` : "");
  const pxScale = viewport.zoom * Math.sqrt(Math.abs(layer.matrix.a * layer.matrix.d - layer.matrix.b * layer.matrix.c));

  // Leaving draw mode (or switching layer) drops any half-drawn path.
  useEffect(() => {
    setPolyPoints([]);
    setStroke(null);
  }, [p.drawing, layer.clipId]);

  const finishPolygon = (pts: Point[]) => {
    if (pts.length >= 3) p.onCreatePath("polygon", pts.map((c) => ({ x: c.x / W, y: c.y / H })));
    setPolyPoints([]);
  };

  useEffect(() => {
    if (!p.drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPolyPoints([]);
        setStroke(null);
        p.onCancelDraw();
      } else if (p.drawing === "polygon" && e.key === "Enter") {
        e.preventDefault();
        finishPolygon(polyPoints);
      } else if (p.drawing === "polygon" && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        setPolyPoints((q) => q.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }); // re-bound each render: reads the latest points

  const begin = (e: React.PointerEvent, g: Gesture) => {
    if (p.locked) return;
    e.stopPropagation();
    e.preventDefault();
    capture(e);
    gesture.current = g;
    lastPatch.current = null;
  };

  const patchFor = (g: Gesture, c: Point, shift: boolean): MaskPatch | null => {
    switch (g.kind) {
      case "move":
        return { x: g.mask.x + (c.x - g.start.x) / W, y: g.mask.y + (c.y - g.start.y) / H };
      case "corner": {
        const rad = (g.mask.rotation * Math.PI) / 180;
        const u = { x: Math.cos(rad), y: Math.sin(rad) };
        const v = { x: -Math.sin(rad), y: Math.cos(rad) };
        const dx = c.x - g.opposite.x;
        const dy = c.y - g.opposite.y;
        const du = dx * u.x + dy * u.y;
        const dv = dx * v.x + dy * v.y;
        const cx = g.opposite.x + (du * u.x + dv * v.x) / 2;
        const cy = g.opposite.y + (du * u.y + dv * v.y) / 2;
        return { x: cx / W, y: cy / H, width: Math.max(1, Math.abs(du)) / W, height: Math.max(1, Math.abs(dv)) / H };
      }
      case "rotate": {
        let deg = (Math.atan2(c.y - g.center.y, c.x - g.center.x) * 180) / Math.PI + 90;
        if (shift) deg = Math.round(deg / 15) * 15;
        // Keep continuity with the starting angle (no jump across ±180).
        while (deg - g.mask.rotation > 180) deg -= 360;
        while (deg - g.mask.rotation < -180) deg += 360;
        return { rotation: deg };
      }
      case "vertex": {
        const q = contentToMaskBox(g.mask, W, H, c);
        return { points: g.mask.points!.map((pt, i) => (i === g.index ? q : pt)) };
      }
      case "stroke":
        return null;
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const s = screenPos(e);
    if (p.drawing === "polygon") setHover(s);
    const g = gesture.current;
    if (!g) return;
    e.stopPropagation();
    const c = toContent(s);
    if (g.kind === "stroke") {
      const last = g.points[g.points.length - 1];
      if (!last || Math.hypot(toScreen(last).x - s.x, toScreen(last).y - s.y) >= 2) {
        g.points.push(c);
        setStroke([...g.points]);
      }
      return;
    }
    const patch = patchFor(g, c, e.shiftKey);
    if (patch) {
      lastPatch.current = patch;
      p.onDraft(g.mask.id, patch);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    e.stopPropagation();
    if (g.kind === "stroke") {
      setStroke(null);
      if (g.points.length >= 3) {
        // Tolerance ≈ 1.5 screen px, in normalized layer units.
        const tol = 1.5 / Math.max(1e-6, pxScale * Math.max(W, H));
        const norm = g.points.map((c) => ({ x: c.x / W, y: c.y / H }));
        p.onCreatePath("freeform", simplifyStroke(norm, tol));
      }
      return;
    }
    const patch = lastPatch.current;
    lastPatch.current = null;
    p.onDraft(g.mask.id, null);
    if (patch) p.onCommit(g.mask.id, patch);
  };

  // DRAW MODE: the whole overlay captures input.
  const onDrawDown = (e: React.PointerEvent) => {
    if (!p.drawing || p.locked) return;
    e.stopPropagation();
    e.preventDefault();
    const s = screenPos(e);
    const c = toContent(s);
    if (p.drawing === "polygon") {
      if (polyPoints.length >= 3) {
        const first = toScreen(polyPoints[0]);
        if (Math.hypot(first.x - s.x, first.y - s.y) <= CLOSE_RADIUS_PX) return finishPolygon(polyPoints);
      }
      setPolyPoints((q) => [...q, c]);
      return;
    }
    capture(e);
    gesture.current = { kind: "stroke", points: [c] };
    setStroke([c]);
  };

  const active = p.masks.find((m) => m.id === p.activeMaskId) ?? null;
  const handle = (key: string, at: Point, onDown: (e: React.PointerEvent) => void, cursor: string, round = false) => (
    <rect
      key={key}
      x={at.x - 5}
      y={at.y - 5}
      width={10}
      height={10}
      rx={round ? 5 : 1.5}
      fill="white"
      stroke={p.accent}
      strokeWidth={1.5}
      style={{ cursor, pointerEvents: "all" }}
      onPointerDown={onDown}
      data-mask-handle={key}
    />
  );

  let activeUi: React.ReactNode = null;
  if (active && !p.drawing) {
    const outline = maskContentPolygon(active, W, H, pxScale).map(toScreen);
    const box = maskBoxCorners(active, W, H);
    const boxS = box.map(toScreen);
    const centerC = { x: active.x * W, y: active.y * H };
    const topMid = { x: (boxS[0].x + boxS[1].x) / 2, y: (boxS[0].y + boxS[1].y) / 2 };
    const centerS = toScreen(centerC);
    const len = Math.hypot(topMid.x - centerS.x, topMid.y - centerS.y) || 1;
    const knob = { x: topMid.x + ((topMid.x - centerS.x) / len) * 22, y: topMid.y + ((topMid.y - centerS.y) / len) * 22 };
    activeUi = (
      <g>
        <path
          d={pathD(outline)}
          fill="transparent"
          stroke={p.accent}
          strokeWidth={2}
          style={{ cursor: p.locked ? "default" : "move", pointerEvents: "all" }}
          onPointerDown={(e) => begin(e, { kind: "move", mask: active, start: toContent(screenPos(e)) })}
          data-mask-body={active.id}
        />
        <path d={pathD(boxS)} fill="none" stroke={p.accent} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} style={{ pointerEvents: "none" }} />
        <line x1={topMid.x} y1={topMid.y} x2={knob.x} y2={knob.y} stroke={p.accent} strokeWidth={1} style={{ pointerEvents: "none" }} />
        {handle("rotate", knob, (e) => begin(e, { kind: "rotate", mask: active, center: centerC }), "grab", true)}
        {boxS.map((pt, i) => handle(`corner-${i}`, pt, (e) => begin(e, { kind: "corner", mask: active, opposite: box[(i + 2) % 4] }), i % 2 === 0 ? "nwse-resize" : "nesw-resize"))}
        {maskControlPoints(active, W, H)
          .map(toScreen)
          .map((pt, i) => (
            <circle key={`v${i}`} cx={pt.x} cy={pt.y} r={4.5} fill={p.accent} stroke="white" strokeWidth={1.5} style={{ cursor: "crosshair", pointerEvents: "all" }} onPointerDown={(e) => begin(e, { kind: "vertex", mask: active, index: i })} data-mask-vertex={i} />
          ))}
      </g>
    );
  }

  const polyS = polyPoints.map(toScreen);
  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: p.drawing ? "all" : "none", cursor: p.drawing ? "crosshair" : undefined }}
      onPointerDown={onDrawDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => {
        if (p.drawing) {
          e.stopPropagation();
          if (p.drawing === "polygon") finishPolygon(polyPoints);
        }
      }}
      data-testid="mask-overlay"
    >
      {p.masks
        .filter((m) => m.id !== active?.id || p.drawing)
        .map((m) => (
          <path
            key={m.id}
            d={pathD(maskContentPolygon(m, W, H, pxScale).map(toScreen))}
            fill="transparent"
            stroke={p.accent}
            strokeWidth={1.25}
            strokeDasharray={m.enabled ? undefined : "4 3"}
            opacity={0.65}
            style={{ pointerEvents: p.drawing ? "none" : "stroke", cursor: "pointer" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              p.onSelectMask(m.id);
            }}
          />
        ))}
      {activeUi}
      {p.drawing === "polygon" && polyS.length > 0 && (
        <g style={{ pointerEvents: "none" }}>
          <path d={pathD(hover ? [...polyS, hover] : polyS, false)} fill="none" stroke={p.accent} strokeWidth={1.5} />
          {polyS.map((pt, i) => (
            <circle key={i} cx={pt.x} cy={pt.y} r={i === 0 && polyS.length >= 3 ? 6 : 3.5} fill={i === 0 ? "white" : p.accent} stroke={p.accent} strokeWidth={1.5} />
          ))}
        </g>
      )}
      {stroke && <path d={pathD(stroke.map(toScreen), false)} fill="none" stroke={p.accent} strokeWidth={1.5} style={{ pointerEvents: "none" }} />}
    </svg>
  );
}
