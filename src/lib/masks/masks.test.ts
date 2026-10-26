import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import type { TimelineModel } from "../timeline/model";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { deserializeTimeline, serializeTimeline, ProjectFormatError, PROJECT_VERSION } from "../timeline/serialize";
import { applyVisualPatch, BLEND_MODES, defaultClipVisual, InvalidVisualError } from "../timeline/visual";
import { applyAnimation, getProperty, valueAt } from "../animation/properties";
import { resolveFrame, type ResolvedLayer } from "../composition/resolve";
import { compositeOperationFor, decontaminatedMatteInPlace, drawResolvedFrame, lumaToAlpha, maskPlanFor, rasterMasksFor, type Ctx2D } from "../composition/draw";
import { multiply, scale as scaleMatrix } from "../composition/matrix";
import { fakeContext } from "../composition/test-helpers";
import { sampleAt, normalizeSequence } from "../composition/frame-sequence";
import { alphaToMatteRgba, canRemoveBackground, generateClipMatte, matteSourceIdFor, MatteGenerationError, MAX_MATTE_CLIP_SECONDS, type MatteAlpha } from "../composition/matte-generation";
import { MatteTrack } from "../composition/matte-track";
import { applyMaskPatch, boxFromLayerPoints, createMask, InvalidMaskError, maskKeyframes, maskParamPath, normalizeMask, parseMaskPath, simplifyStroke, type Mask } from "./model";
import { contentToMaskBox, maskContentPolygon, maskControlPoints, pointInPolygon } from "./geometry";
import { combine, edgeProfile, MaskRasterCache, polygonCoverage, rasterizeMasks, shapeCoverage, signedDistanceField, squaredDistanceTransform, stackStartsFull, type RasterMask } from "./raster";

/**
 * PHASE 13 — MASKS & ADVANCED COMPOSITING acceptance suite. The rasterizer is
 * pure JS, so coverage/feather/expansion/inversion/combination are asserted
 * on exact pixel values here; the canvas integration is asserted through the
 * draw core's call sequence (which surface, which composite op, fast vs raster
 * path), and real pixels are verified in the browser (test report).
 */

// ---- helpers -----------------------------------------------------------------

function project() {
  return new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw (r as unknown as { error: Error }).error;
  return r as Extract<T, { ok: true }>;
}
function addRectLayer(e: TimelineEngine, w = 400, h = 200) {
  return ok(e.addGraphicLayer({ graphic: { shape: normalizeShapeSpec({ type: "rect", width: w, height: h, fill: true, fillColor: "#ff0000" }) }, atFrame: 0, durationFrames: 120 })).clip.id;
}
function addVideo(e: TimelineEngine, sourceId = "v", inF = 0, outF = 90) {
  const t = ok(e.addTrack("video", "Video")).track.id;
  return ok(e.insertClip(t, { kind: "video", source: { sourceId }, sourceInFrame: inF, sourceOutFrame: outF }, 0)).clip.id;
}
const SOURCES = { v: { width: 1920, height: 1080 }, img: { width: 800, height: 600 }, matte: { width: 400, height: 300 } };
const ctx = () => fakeContext(SOURCES);
const layerOf = (tl: TimelineModel, id: string, f = 0): ResolvedLayer => resolveFrame(tl, f, ctx()).layers.find((l) => l.clipId === id)!;
const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const rm = (polygon: { x: number; y: number }[], extra: Partial<RasterMask> = {}): RasterMask => ({ polygon, mode: "add", inverted: false, feather: 0, expansion: 0, opacity: 1, ...extra });

// ---- model ----------------------------------------------------------------------

describe("mask model", () => {
  it("creates every shape with sane defaults; path shapes get points", () => {
    for (const t of ["rectangle", "ellipse", "polygon", "freeform"] as const) {
      const m = createMask("m1", t);
      expect(m).toMatchObject({ id: "m1", type: t, mode: "add", enabled: true, inverted: false, x: 0.5, y: 0.5, feather: 0, expansion: 0, opacity: 1 });
      expect(!!m.points).toBe(t === "polygon" || t === "freeform");
    }
  });

  it("a drawn path becomes its bounding box + points normalized inside it", () => {
    const m = createMask("p", "polygon", { layerPoints: [{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.4, y: 0.5 }] });
    expect(m.x).toBeCloseTo(0.4);
    expect(m.y).toBeCloseTo(0.3);
    expect(m.width).toBeCloseTo(0.4);
    expect(m.height).toBeCloseTo(0.4);
    expect(m.points![0]).toEqual({ x: 0, y: 0 });
    expect(m.points![2].x).toBeCloseTo(0.5);
    expect(m.points![2].y).toBeCloseTo(1);
    // and maps back to exactly the drawn layer positions (content 100x100)
    const back = maskControlPoints(m, 100, 100);
    expect(back[0].x).toBeCloseTo(20);
    expect(back[0].y).toBeCloseTo(10);
    expect(back[2].x).toBeCloseTo(40);
    expect(back[2].y).toBeCloseTo(50);
  });

  it("patches clamp ranges and reject non-finite values / bad enums / too few points", () => {
    const m = createMask("m", "rectangle");
    expect(applyMaskPatch(m, { opacity: 3, feather: -5, width: 0, roundness: 9 })).toMatchObject({ opacity: 1, feather: 0, width: 0.001, roundness: 0.5 });
    expect(() => applyMaskPatch(m, { x: NaN })).toThrow(InvalidMaskError);
    expect(() => applyMaskPatch(m, { mode: "xor" as never })).toThrow(InvalidMaskError);
    expect(() => applyMaskPatch(m, { type: "polygon" })).toThrow(/needs points/);
    expect(() => applyMaskPatch(createMask("p", "polygon"), { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toThrow(InvalidMaskError);
    // switching to a box shape drops the path
    expect(applyMaskPatch(createMask("p", "polygon"), { type: "ellipse" }).points).toBeUndefined();
  });

  it("normalizeMask validates untrusted data", () => {
    expect(normalizeMask({ id: "a", type: "ellipse", feather: 12 })).toMatchObject({ id: "a", type: "ellipse", feather: 12, mode: "add" });
    expect(normalizeMask({ id: "a.b", type: "ellipse" })).toBeNull();
    expect(normalizeMask({ id: "a", type: "star" })).toBeNull();
    expect(normalizeMask({ id: "a", type: "polygon", points: [{ x: 0, y: 0 }] })).toBeNull();
    expect(normalizeMask({ id: "a", type: "rectangle", mode: "nope" })).toBeNull();
  });

  it("parses keyframe paths for animatable params only", () => {
    expect(parseMaskPath("masks.mask-1.feather")).toEqual({ maskId: "mask-1", param: "feather" });
    expect(parseMaskPath("masks.mask-1.points")).toBeNull();
    expect(parseMaskPath("effects.fx.amount")).toBeNull();
    expect(maskParamPath("m", "x")).toBe("masks.m.x");
  });

  it("simplifies a dense freeform stroke but keeps its corners", () => {
    const stroke = [];
    for (let i = 0; i <= 100; i++) stroke.push({ x: i / 100, y: 0 });
    for (let i = 1; i <= 100; i++) stroke.push({ x: 1, y: i / 100 });
    const s = simplifyStroke(stroke, 0.002);
    expect(s.length).toBe(3);
    expect(s[1]).toEqual({ x: 1, y: 0 });
    expect(boxFromLayerPoints(s).width).toBeCloseTo(1);
  });
});

// ---- geometry -------------------------------------------------------------------

describe("mask geometry (layer content space)", () => {
  it("rectangle box maps to content pixels; rotation turns it about its center", () => {
    const m = { ...createMask("r", "rectangle"), x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    const p = maskContentPolygon(m, 200, 100);
    expect(p).toEqual([
      { x: 50, y: 25 },
      { x: 150, y: 25 },
      { x: 150, y: 75 },
      { x: 50, y: 75 },
    ]);
    const r = maskContentPolygon({ ...m, rotation: 90 }, 200, 100);
    // a 100x50 box rotated 90° about (100, 50) spans 50 wide, 100 tall
    expect(r[0].x).toBeCloseTo(125);
    expect(r[0].y).toBeCloseTo(0);
    expect(r[2].x).toBeCloseTo(75);
    expect(r[2].y).toBeCloseTo(100);
  });

  it("curves flatten adaptively: more segments at higher render scale", () => {
    const e = createMask("e", "ellipse");
    const small = maskContentPolygon(e, 100, 100, 0.25).length;
    const big = maskContentPolygon(e, 100, 100, 8).length;
    expect(big).toBeGreaterThan(small);
    // chord error under ~0.25 px: every vertex lies on the ellipse
    for (const p of maskContentPolygon(e, 100, 100, 8)) expect(Math.hypot((p.x - 50) / 30, (p.y - 50) / 30)).toBeCloseTo(1, 6);
  });

  it("rounded rectangles stay inside the box and round the corners", () => {
    const m = { ...createMask("r", "rectangle"), roundness: 0.5, width: 1, height: 1 };
    const p = maskContentPolygon(m, 100, 100, 1);
    expect(pointInPolygon(p, { x: 1, y: 1 })).toBe(false); // corner cut
    expect(pointInPolygon(p, { x: 50, y: 1 })).toBe(true);
    for (const v of p) expect(Math.hypot(v.x - 50, v.y - 50)).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("freeform is a smooth curve THROUGH its points (polygon is straight between them)", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const free = { ...createMask("f", "freeform"), x: 0.5, y: 0.5, width: 1, height: 1, points: pts };
    const curve = maskContentPolygon(free, 100, 100, 4);
    expect(curve.length).toBeGreaterThan(4);
    expect(curve.some((p) => Math.abs(p.x - 0) < 1e-9 && Math.abs(p.y - 0) < 1e-9)).toBe(true); // passes through vertex
    // bulges outward between vertices (not a straight edge)
    expect(Math.min(...curve.map((p) => p.y))).toBeLessThan(0);
  });

  it("contentToMaskBox inverts the box transform (vertex drags)", () => {
    const m = { ...createMask("p", "polygon"), x: 0.3, y: 0.6, width: 0.4, height: 0.2, rotation: 33 };
    const cps = maskControlPoints(m, 640, 360);
    cps.forEach((p, i) => {
      const back = contentToMaskBox(m, 640, 360, p);
      expect(back.x).toBeCloseTo(m.points![i].x, 9);
      expect(back.y).toBeCloseTo(m.points![i].y, 9);
    });
  });
});

// ---- rasterizer -------------------------------------------------------------------

describe("mask rasterizer: coverage", () => {
  it("exact fractional horizontal coverage", () => {
    const c = polygonCoverage(rect(1.25, 1, 3.75, 3), { x: 0, y: 0, width: 5, height: 4 });
    const row = (y: number) => Array.from(c.slice(y * 5, y * 5 + 5)).map((v) => +v.toFixed(5));
    expect(row(0)).toEqual([0, 0, 0, 0, 0]);
    expect(row(1)).toEqual([0, 0.75, 1, 0.75, 0]);
    expect(row(2)).toEqual([0, 0.75, 1, 0.75, 0]);
    expect(row(3)).toEqual([0, 0, 0, 0, 0]);
  });

  it("respects the region offset", () => {
    const c = polygonCoverage(rect(11, 21, 13, 22), { x: 10, y: 20, width: 4, height: 3 });
    expect(Array.from(c.slice(4, 8))).toEqual([0, 1, 1, 0]);
  });

  it("total coverage equals the polygon's area (antialiasing conserves area)", () => {
    const tri = [
      { x: 2.3, y: 2.1 },
      { x: 30.2, y: 5.7 },
      { x: 10.4, y: 28.9 },
    ];
    const area = Math.abs((tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[2].x - tri[0].x) * (tri[1].y - tri[0].y)) / 2;
    expect(sum(polygonCoverage(tri, { x: 0, y: 0, width: 32, height: 32 }))).toBeCloseTo(area, 0);
  });

  it("fills with the NONZERO rule (a pentagram's center is covered, like canvas clip())", () => {
    const star = [0, 2, 4, 1, 3].map((k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / 5;
      return { x: 20 + 18 * Math.cos(a), y: 20 + 18 * Math.sin(a) };
    });
    const c = polygonCoverage(star, { x: 0, y: 0, width: 40, height: 40 });
    expect(c[20 * 40 + 20]).toBe(1);
    expect(pointInPolygon(star, { x: 20, y: 20 })).toBe(true);
  });

  it("degenerate input is empty, never NaN", () => {
    expect(sum(polygonCoverage([{ x: 0, y: 0 }, { x: 5, y: 5 }], { x: 0, y: 0, width: 8, height: 8 }))).toBe(0);
    expect(sum(polygonCoverage(rect(0, 0, NaN, 4), { x: 0, y: 0, width: 8, height: 8 }))).toBe(0);
  });
});

describe("mask rasterizer: distance transform, expansion, feather", () => {
  it("squared EDT matches brute force", () => {
    const w = 13;
    const h = 9;
    const feat = new Uint8Array(w * h);
    let seed = 7;
    for (let i = 0; i < feat.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      feat[i] = seed % 11 === 0 ? 1 : 0;
    }
    feat[0] = 1;
    const d = squaredDistanceTransform(feat, w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (feat[j * w + i]) best = Math.min(best, (x - i) ** 2 + (y - j) ** 2);
        expect(d[y * w + x]).toBe(best);
      }
  });

  it("the signed distance field is SUB-PIXEL accurate on straight and slanted edges", () => {
    // vertical edge at x = 30.3 (region px): pixel centers sit at index + 0.5
    const region = { x: 0, y: 0, width: 60, height: 3 };
    const sdf = signedDistanceField(polygonCoverage(rect(-10, -10, 30.3, 20), region), 60, 3);
    for (let x = 15; x < 45; x++) expect(sdf[60 + x]).toBeCloseTo(x + 0.5 - 30.3, 1);
    // 30° slanted half-plane: analytic distance to the line
    const W = 64;
    const ang = (30 * Math.PI) / 180;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    const c0 = 32 * nx + 32 * ny; // line through (32, 32) with normal n; inside = n·p < c0
    const far = 500;
    const poly = [
      { x: 32 - ny * far - nx * far, y: 32 + nx * far - ny * far },
      { x: 32 + ny * far - nx * far, y: 32 - nx * far - ny * far },
      { x: 32 + ny * far, y: 32 - nx * far },
      { x: 32 - ny * far, y: 32 + nx * far },
    ];
    const cov = polygonCoverage(poly, { x: 0, y: 0, width: W, height: W });
    const field = signedDistanceField(cov, W, W);
    let worst = 0;
    for (let y = 8; y < 56; y++)
      for (let x = 8; x < 56; x++) {
        const truth = (x + 0.5) * nx + (y + 0.5) * ny - c0;
        if (Math.abs(truth) < 12) worst = Math.max(worst, Math.abs(field[y * W + x] - truth));
      }
    expect(worst).toBeLessThan(0.12);
  });

  it("an (almost) zero expansion through the distance field matches the exact scanline coverage", () => {
    // Regression for a live-test finding: centre-to-centre distances put raster-path edges up to 0.5 px off.
    const region = { x: 0, y: 0, width: 80, height: 80 };
    const ell = Array.from({ length: 96 }, (_, k) => ({ x: 40 + 30 * Math.cos((2 * Math.PI * k) / 96 + 0.3), y: 40 + 18 * Math.sin((2 * Math.PI * k) / 96 + 0.3) }));
    const exact = polygonCoverage(ell, region);
    const viaSdf = shapeCoverage(rm(ell, { expansion: 1e-4 }), region);
    let maxDiff = 0;
    for (let i = 0; i < exact.length; i++) maxDiff = Math.max(maxDiff, Math.abs(exact[i] - viaSdf[i]));
    expect(maxDiff).toBeLessThan(0.2);
    expect(Math.abs(sum(viaSdf) - sum(exact))).toBeLessThan(3);
  });

  it("coverage has no float-drift residue far from the shape (it would read as phantom edges)", () => {
    // Regression for a live-test finding: a large rotated ellipse left 1.5e-8 values in empty rows, and the distance
    // field turned each into an edge — the raster path covered 13% more than the exact shape.
    const W = 460;
    const H = 220;
    const ell = Array.from({ length: 63 }, (_, k) => {
      const a = (2 * Math.PI * k) / 63;
      const x = 200 * Math.cos(a);
      const y = 90 * Math.sin(a);
      return { x: W / 2 + x * Math.cos(0.52) - y * Math.sin(0.52), y: H / 2 + x * Math.sin(0.52) + y * Math.cos(0.52) };
    });
    const region = { x: 0, y: 0, width: W, height: H };
    const exact = polygonCoverage(ell, region);
    for (const v of exact) expect(v === 0 || v === 1 || (v > 1e-4 && v < 1 - 1e-4)).toBe(true);
    const viaSdf = shapeCoverage(rm(ell, { expansion: 1e-4 }), region);
    expect(Math.abs(sum(viaSdf) - sum(exact)) / sum(exact)).toBeLessThan(0.001);
  });

  it("expansion grows a square by e with ROUND corners; negative shrinks it", () => {
    const region = { x: 0, y: 0, width: 60, height: 60 };
    const grown = sum(shapeCoverage(rm(rect(20, 20, 40, 40), { expansion: 5 }), region));
    expect(grown).toBeCloseTo(30 * 30 - (4 - Math.PI) * 25, -1); // within ~±5 px²
    expect(Math.abs(grown - (900 - (4 - Math.PI) * 25)) / 878).toBeLessThan(0.02);
    const shrunk = sum(shapeCoverage(rm(rect(20, 20, 40, 40), { expansion: -5 }), region));
    expect(Math.abs(shrunk - 100) / 100).toBeLessThan(0.06);
  });

  it("feather is a symmetric soft ramp centered on the edge", () => {
    const c = shapeCoverage(rm(rect(30, -10, 200, 10), { feather: 10 }), { x: 0, y: 0, width: 60, height: 1 });
    expect(c[29] + c[30]).toBeCloseTo(1, 5); // symmetric about the edge at x = 30
    expect(c[20]).toBe(0);
    expect(c[40]).toBe(1);
    for (let x = 1; x < 60; x++) expect(c[x]).toBeGreaterThanOrEqual(c[x - 1]);
    // soft: several partially covered pixels, not a 1px ramp
    expect(Array.from(c).filter((v) => v > 0.02 && v < 0.98).length).toBeGreaterThanOrEqual(8);
  });

  it("an edge just OUTSIDE the region still feathers into it (influence margin)", () => {
    const c = shapeCoverage(rm(rect(62, -10, 200, 10), { feather: 10 }), { x: 0, y: 0, width: 60, height: 1 });
    expect(c[59]).toBeGreaterThan(0.1);
    expect(c[50]).toBe(0);
  });

  it("a sub-pixel sliver can still be grown into a visible shape", () => {
    const c = shapeCoverage(rm(rect(10, 10, 10.3, 10.3), { expansion: 4 }), { x: 0, y: 0, width: 21, height: 21 });
    expect(c[10 * 21 + 10]).toBe(1);
    expect(sum(c)).toBeGreaterThan(30);
  });

  it("edge profile: 1px AA without feather, smoothstep with it", () => {
    expect(edgeProfile(0, 0)).toBe(0.5);
    expect(edgeProfile(-1, 0)).toBe(1);
    expect(edgeProfile(1, 0)).toBe(0);
    expect(edgeProfile(0, 10)).toBe(0.5);
    expect(edgeProfile(-5, 10)).toBe(1);
    expect(edgeProfile(5, 10)).toBe(0);
  });
});

describe("mask rasterizer: inversion, opacity, multiple masks", () => {
  const region = { x: 0, y: 0, width: 10, height: 1 };
  const left = rect(0, -1, 6, 2); // covers x 0..5
  const right = rect(4, -1, 10, 2); // covers x 4..9
  const at = (c: Float32Array) => Array.from(c).map((v) => +v.toFixed(4));

  it("inversion keeps the outside; opacity scales the contribution", () => {
    expect(at(rasterizeMasks([rm(left, { inverted: true })], region))).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(at(rasterizeMasks([rm(left, { opacity: 0.5 })], region))).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
  });

  it("add / subtract / intersect / difference combine in order", () => {
    expect(at(rasterizeMasks([rm(left), rm(right)], region))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(at(rasterizeMasks([rm(left), rm(right, { mode: "subtract" })], region))).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(at(rasterizeMasks([rm(left), rm(right, { mode: "intersect" })], region))).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
    expect(at(rasterizeMasks([rm(left), rm(right, { mode: "difference" })], region))).toEqual([1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
  });

  it("a stack that STARTS by subtracting carves from the full layer (After Effects)", () => {
    expect(stackStartsFull([{ mode: "subtract" }])).toBe(true);
    expect(stackStartsFull([{ mode: "add" }, { mode: "subtract" }])).toBe(false);
    expect(at(rasterizeMasks([rm(left, { mode: "subtract" })], region))).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(at(rasterizeMasks([rm(left, { mode: "intersect" })], region))).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("combine() formulas", () => {
    expect(combine(0.5, 0.5, "add")).toBe(0.75);
    expect(combine(0.5, 0.5, "subtract")).toBe(0.25);
    expect(combine(0.5, 0.5, "intersect")).toBe(0.25);
    expect(combine(0.2, 0.7, "difference")).toBeCloseTo(0.5);
  });

  it("the raster cache hits on identical inputs and misses on any change", () => {
    const cache = new MaskRasterCache(2);
    const a = cache.get([rm(left)], region);
    expect(cache.get([rm(left)], region)).toBe(a);
    expect(cache.get([rm(left, { feather: 2 })], region)).not.toBe(a);
    expect(cache.get([rm(rect(0, -1, 6.5, 2))], region)).not.toBe(a);
    expect(cache.size).toBe(2); // LRU bounded
  });
});

// ---- ops, undo/redo, keyframes ------------------------------------------------------

describe("mask operations (timeline)", () => {
  it("add / update / move / duplicate / remove — each one undo step", () => {
    const e = project();
    const id = addRectLayer(e);
    const a = ok(e.addMask(id, "rectangle")).mask;
    const b = ok(e.addMask(id, "ellipse", { patch: { feather: 8 } })).mask;
    expect(e.timeline.clips[id].masks!.map((m) => m.id)).toEqual([a.id, b.id]);
    ok(e.updateMask(id, a.id, { inverted: true, mode: "subtract", x: 0.25 }));
    expect(e.timeline.clips[id].masks![0]).toMatchObject({ inverted: true, mode: "subtract", x: 0.25 });
    ok(e.moveMask(id, b.id, 0));
    expect(e.timeline.clips[id].masks![0].id).toBe(b.id);
    const copy = ok(e.duplicateMask(id, b.id)).mask;
    expect(e.timeline.clips[id].masks!.map((m) => m.id)).toEqual([b.id, copy.id, a.id]);
    ok(e.removeMask(id, copy.id));
    expect(e.timeline.clips[id].masks!.length).toBe(2);
    e.undo();
    expect(e.timeline.clips[id].masks!.length).toBe(3);
    e.undo(); // duplicate
    e.undo(); // move
    expect(e.timeline.clips[id].masks![0].id).toBe(a.id);
    e.redo();
    expect(e.timeline.clips[id].masks![0].id).toBe(b.id);
  });

  it("rejects audio clips, locked tracks, unknown masks, invalid values", () => {
    const e = project();
    const id = addRectLayer(e);
    const at = ok(e.addTrack("audio", "A")).track.id;
    const aud = ok(e.insertClip(at, { kind: "audio", source: { sourceId: "a" }, sourceInFrame: 0, sourceOutFrame: 30 }, 0)).clip.id;
    expect(e.addMask(aud, "rectangle")).toMatchObject({ ok: false, error: { reason: "kind-mismatch" } });
    expect(e.updateMask(id, "nope", { x: 1 })).toMatchObject({ ok: false, error: { reason: "mask-not-found" } });
    const m = ok(e.addMask(id, "rectangle")).mask;
    expect(e.updateMask(id, m.id, { feather: Infinity })).toMatchObject({ ok: false, error: { reason: "invalid-mask" } });
    expect(e.addMask(id, "polygon", { layerPoints: [{ x: 0, y: 0 }] })).toMatchObject({ ok: false, error: { reason: "invalid-mask" } });
    ok(e.setTrackLocked(e.timeline.clips[id].trackId, true));
    expect(e.addMask(id, "ellipse")).toMatchObject({ ok: false, error: { reason: "track-locked" } });
  });

  it("mask params keyframe through the Phase 8 engine; edits auto-key at the playhead", () => {
    const e = project();
    const id = addRectLayer(e);
    const m = ok(e.addMask(id, "ellipse")).mask;
    const path = maskParamPath(m.id, "x");
    ok(e.setPropertyAnimated(id, path, true, 0)); // key at 0 holding 0.5
    ok(e.updateMask(id, m.id, { x: 0.8 }, 60)); // auto-key at 60
    const clip = e.timeline.clips[id];
    expect(clip.masks![0].x).toBe(0.5); // base untouched
    expect(valueAt(clip, path, 30, e.timeline.composition)).toBeCloseTo(0.65);
    expect(applyAnimation(clip, 60, e.timeline.composition).masks![0].x).toBeCloseTo(0.8);
    // feather keyframed too, clamped by the property
    ok(e.addKeyframe(id, maskParamPath(m.id, "feather"), 0, 0));
    ok(e.addKeyframe(id, maskParamPath(m.id, "feather"), 30, 40));
    expect(maskKeyframes(e.timeline.clips[id].animation, m.id).feather!.keyframes.length).toBe(2);
    expect(getProperty(maskParamPath(m.id, "opacity"))!.set(clip, 5, e.timeline.composition).masks![0].opacity).toBe(1);
    // the renderer sees evaluated values
    expect(layerOf(e.timeline, id, 30).masks[0].x).toBeCloseTo(0.65);
    expect(layerOf(e.timeline, id, 15).masks[0].feather).toBeCloseTo(20);
  });

  it("removing a mask removes its keyframes; duplicating copies them under the new id", () => {
    const e = project();
    const id = addRectLayer(e);
    const m = ok(e.addMask(id, "ellipse")).mask;
    ok(e.setPropertyAnimated(id, maskParamPath(m.id, "y"), true, 0));
    const copy = ok(e.duplicateMask(id, m.id)).mask;
    expect(Object.keys(e.timeline.clips[id].animation!.tracks).sort()).toEqual([maskParamPath(copy.id, "y"), maskParamPath(m.id, "y")].sort());
    ok(e.removeMask(id, m.id));
    ok(e.removeMask(id, copy.id));
    expect(e.timeline.clips[id].animation).toBeUndefined();
    expect(e.timeline.clips[id].masks).toBeUndefined();
  });

  it("split keeps masks on both halves and shifts mask keyframes with the right half", () => {
    const e = project();
    const id = addRectLayer(e);
    const m = ok(e.addMask(id, "rectangle")).mask;
    ok(e.addKeyframe(id, maskParamPath(m.id, "x"), 0, 0.2));
    ok(e.addKeyframe(id, maskParamPath(m.id, "x"), 100, 0.7));
    const { right } = ok(e.splitClip(id, 50));
    const r = e.timeline.clips[right.id];
    expect(r.masks![0].id).toBe(m.id);
    expect(layerOf(e.timeline, right.id, 50).masks[0].x).toBeCloseTo(layerOf(e.timeline, id, 49).masks[0].x + 0.5 / 100, 4);
  });

  it("disabled masks are not rendered; masks follow the layer transform", () => {
    const e = project();
    const id = addRectLayer(e, 400, 200);
    const m = ok(e.addMask(id, "rectangle", { patch: { x: 0.25, width: 0.5, height: 1 } })).mask;
    const before = layerOf(e.timeline, id);
    const poly = rasterMasksFor(before, before.matrix)[0].polygon;
    ok(e.setClipVisual(id, { transform: { x: 1000, y: 600, scaleX: 2, scaleY: 2 } }));
    const after = layerOf(e.timeline, id);
    const moved = rasterMasksFor(after, after.matrix)[0].polygon;
    // mask's left edge = layer's left edge in both, wherever the layer is
    expect(poly[0].x).toBeCloseTo(before.bounds.x);
    expect(moved[0].x).toBeCloseTo(after.bounds.x);
    expect(moved[1].x - moved[0].x).toBeCloseTo(2 * (poly[1].x - poly[0].x)); // scaled with the layer
    ok(e.updateMask(id, m.id, { enabled: false }));
    expect(layerOf(e.timeline, id).masks).toEqual([]);
  });
});

// ---- persistence ----------------------------------------------------------------------

describe("mask & compositing persistence (v10)", () => {
  it("round-trips masks, mask keyframes, new blend modes and luma mattes exactly", () => {
    const e = project();
    const id = addRectLayer(e);
    const p = ok(e.addMask(id, "freeform", { layerPoints: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.2 }, { x: 0.5, y: 0.9 }, { x: 0.2, y: 0.6 }], patch: { feather: 12, expansion: -3, inverted: true } })).mask;
    ok(e.addMask(id, "ellipse", { mode: "subtract" }));
    ok(e.addKeyframe(id, maskParamPath(p.id, "rotation"), 10, 45));
    ok(e.setClipVisual(id, { blendMode: "color-dodge", matte: { sourceId: "matte", invert: false, channel: "luma" } }));
    const json = serializeTimeline(e.timeline);
    expect(JSON.parse(json).version).toBe(PROJECT_VERSION);
    const loaded = deserializeTimeline(json);
    expect(loaded.clips[id].masks).toEqual(e.timeline.clips[id].masks);
    expect(loaded.clips[id].animation).toEqual(e.timeline.clips[id].animation);
    expect(loaded.clips[id].visual).toEqual(e.timeline.clips[id].visual);
    expect(serializeTimeline(loaded)).toBe(json);
  });

  it("older (v9) projects load unchanged", () => {
    const e = project();
    const id = addRectLayer(e);
    const doc = JSON.parse(serializeTimeline(e.timeline));
    doc.version = 9;
    expect(deserializeTimeline(JSON.stringify(doc)).clips[id].masks).toBeUndefined();
  });

  it("rejects corrupt masks, orphaned mask keyframes, unknown blend modes and matte channels", () => {
    const e = project();
    const id = addRectLayer(e);
    const m = ok(e.addMask(id, "rectangle")).mask;
    ok(e.setPropertyAnimated(id, maskParamPath(m.id, "x"), true, 0));
    const good = JSON.parse(serializeTimeline(e.timeline));
    const bad = (mutate: (d: typeof good) => void) => {
      const d = structuredClone(good);
      mutate(d);
      return () => deserializeTimeline(JSON.stringify(d));
    };
    expect(bad((d) => (d.timeline.clips[id].masks[0].type = "star"))).toThrow(ProjectFormatError);
    expect(bad((d) => d.timeline.clips[id].masks.push({ ...d.timeline.clips[id].masks[0] }))).toThrow(/duplicate mask ids/);
    expect(bad((d) => (d.timeline.clips[id].masks = []))).toThrow(/invalid animation/);
    expect(bad((d) => (d.timeline.clips[id].visual = { ...defaultClipVisual(1920, 1080), blendMode: "dissolve" }))).toThrow(/blend mode/);
    expect(bad((d) => (d.timeline.clips[id].visual = { ...defaultClipVisual(1920, 1080), matte: { sourceId: "m", invert: false, channel: "red" } }))).toThrow(/matte channel/);
  });
});

// ---- compositing: blend modes, draw paths ------------------------------------------------

type Call = { surface: string; op: string; args: unknown[]; gco?: string; alpha?: number };

function recordingCtx(surface: string, log: Call[], width: number, height: number): Ctx2D {
  const state: Record<string, unknown> = { globalCompositeOperation: "source-over", globalAlpha: 1, imageSmoothingEnabled: true, imageSmoothingQuality: "high", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "", textBaseline: "alphabetic", textAlign: "left", lineJoin: "miter", lineCap: "butt", miterLimit: 10, shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 };
  const canvas = { width, height, __surface: surface };
  return new Proxy({} as Ctx2D, {
    get(_t, prop: string) {
      if (prop === "canvas") return canvas;
      if (prop in state) return state[prop];
      if (prop === "createImageData") return (w: number, h: number) => (log.push({ surface, op: prop, args: [w, h] }), { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (prop === "getImageData") return (_x: number, _y: number, w: number, h: number) => (log.push({ surface, op: prop, args: [w, h] }), { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      return (...args: unknown[]) => log.push({ surface, op: prop, args, gco: state.globalCompositeOperation as string, alpha: state.globalAlpha as number });
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      return true;
    },
  });
}

function drawWithLog(tl: TimelineModel, ids: Record<string, CanvasImageSource | undefined> = {}, f = 0) {
  const log: Call[] = [];
  const scratchUsed: number[] = [];
  const scratches = new Map<number, Ctx2D>();
  const main = recordingCtx("main", log, 1920, 1080);
  const frame = resolveFrame(tl, f, ctx());
  const pixels = new Map(frame.layers.map((l) => [l.clipId, { image: ids[l.clipId] ?? ({ width: 1920, height: 1080 } as unknown as CanvasImageSource), matte: { width: 400, height: 300 } as unknown as CanvasImageSource }]));
  drawResolvedFrame(main, frame, pixels, {
    renderScale: 1,
    smoothing: "high",
    getScratch: (slot = 0) => {
      scratchUsed.push(slot);
      if (!scratches.has(slot)) scratches.set(slot, recordingCtx(`scratch${slot}`, log, 1920, 1080));
      return scratches.get(slot)!;
    },
  });
  return { log, scratchUsed, frame };
}

describe("compositing: blend modes, alpha, ordering", () => {
  it("every blend mode maps 1:1 to a canvas composite operation, add -> lighter", () => {
    expect(BLEND_MODES.length).toBe(17);
    for (const m of BLEND_MODES) expect(compositeOperationFor(m)).toBe(m === "normal" ? "source-over" : m === "add" ? "lighter" : m);
    expect(() => applyVisualPatch(defaultClipVisual(10, 10), { blendMode: "dissolve" as never })).toThrow(InvalidVisualError);
  });

  it("layers composite back-to-front with their opacity and blend mode (alpha compositing)", () => {
    const e = project();
    const bottom = addVideo(e);
    const top = addRectLayer(e);
    ok(e.setClipVisual(top, { opacity: 0.4, blendMode: "soft-light" }));
    const { log, frame } = drawWithLog(e.timeline);
    expect(frame.layers.map((l) => l.clipId)).toEqual([bottom, top]);
    const vid = log.find((c) => c.op === "drawImage" && c.surface === "main")!;
    const shape = log.find((c) => c.op === "fill" && c.surface === "main")!;
    expect(vid.gco).toBe("source-over");
    expect(shape).toMatchObject({ gco: "soft-light", alpha: 0.4 });
    expect(log.indexOf(vid)).toBeLessThan(log.indexOf(shape));
  });
});

describe("compositing: mask render paths", () => {
  it("one crisp mask = canvas CLIP on the main surface: no scratch, no raster (vector stays vector)", () => {
    const e = project();
    const id = addRectLayer(e);
    ok(e.addMask(id, "ellipse"));
    const layer = layerOf(e.timeline, id);
    expect(maskPlanFor(layer).kind).toBe("clip");
    const { log, scratchUsed } = drawWithLog(e.timeline);
    expect(scratchUsed).toEqual([]);
    const clip = log.find((c) => c.op === "clip")!;
    expect(clip).toMatchObject({ surface: "main", args: ["nonzero"] });
    expect(log.some((c) => c.op === "putImageData" || c.op === "getImageData")).toBe(false);
    // clip set BEFORE the shape draws, restored after
    expect(log.indexOf(clip)).toBeLessThan(log.findIndex((c) => c.op === "fill"));
    expect(log.filter((c) => c.op === "save").length).toBe(log.filter((c) => c.op === "restore").length);
  });

  it("inverted rectangle/ellipse also clips (even-odd complement); inverted polygon rasterizes", () => {
    const e = project();
    const id = addRectLayer(e);
    const m = ok(e.addMask(id, "rectangle", { patch: { inverted: true } })).mask;
    const { log } = drawWithLog(e.timeline);
    expect(log.find((c) => c.op === "clip")!.args).toEqual(["evenodd"]);
    expect(log.some((c) => c.op === "rect" && c.surface === "main")).toBe(true);
    ok(e.updateMask(id, m.id, { type: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] }));
    expect(maskPlanFor(layerOf(e.timeline, id)).kind).toBe("raster");
    // a lone SUBTRACT mask is the same complement
    ok(e.updateMask(id, m.id, { type: "ellipse", inverted: false, mode: "subtract" }));
    expect(maskPlanFor(layerOf(e.timeline, id))).toMatchObject({ kind: "clip", inverted: true });
  });

  it("feather / expansion / opacity / several masks -> isolated layer x coverage (destination-in), then opacity+blend", () => {
    const e = project();
    const id = addRectLayer(e);
    ok(e.setClipVisual(id, { opacity: 0.7, blendMode: "screen" }));
    ok(e.addMask(id, "ellipse", { patch: { feather: 20 } }));
    const { log, scratchUsed } = drawWithLog(e.timeline);
    expect(scratchUsed).toContain(0);
    expect(scratchUsed).toContain(4);
    const put = log.find((c) => c.op === "putImageData")!;
    expect(put.surface).toBe("scratch4");
    const apply = log.find((c) => c.op === "drawImage" && c.surface === "scratch0" && c.gco === "destination-in")!;
    expect(apply).toBeTruthy();
    const composite = log.find((c) => c.op === "drawImage" && c.surface === "main")!;
    expect(composite).toMatchObject({ gco: "screen", alpha: 0.7 });
    expect(log.indexOf(put)).toBeLessThan(log.indexOf(apply));
    expect(log.indexOf(apply)).toBeLessThan(log.indexOf(composite));
    // coverage region = layer bounds (+1px), not the whole frame
    const [w, h] = log.find((c) => c.op === "createImageData")!.args as number[];
    expect(w).toBeLessThanOrEqual(400 + 4);
    expect(h).toBeLessThanOrEqual(200 + 4);
  });

  it("matte input then masks: background-removed subject + garbage mask, both on the isolated layer", () => {
    const e = project();
    const id = addVideo(e);
    ok(e.setClipVisual(id, { matte: { sourceId: "matte", invert: false } }));
    ok(e.addMask(id, "rectangle", { patch: { feather: 5 } }));
    const { log } = drawWithLog(e.timeline);
    const ops = log.filter((c) => c.surface === "scratch0" && c.op === "drawImage").map((c) => c.gco);
    expect(ops).toEqual(["source-over", "destination-in", "destination-in"]); // content, matte, masks
  });

  it("luma matte converts luminance x alpha into alpha", () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 128, 128, 128, 128, 255]);
    lumaToAlpha(d);
    expect([d[3], d[7], d[11], d[15]]).toEqual([255, 0, 128, 128]);
    expect(d[0]).toBe(0);
    const e = project();
    const id = addVideo(e);
    ok(e.setClipVisual(id, { matte: { sourceId: "matte", invert: true, channel: "luma" } }));
    const { log, scratchUsed } = drawWithLog(e.timeline);
    expect(scratchUsed).toContain(5);
    expect(log.some((c) => c.surface === "scratch5" && c.op === "putImageData")).toBe(true);
    expect(log.find((c) => c.surface === "scratch0" && c.op === "drawImage" && c.gco === "destination-out")).toBeTruthy();
  });

  it("decontaminated matte: the old background's color is unmixed out of soft edges (no green fringe)", () => {
    // 1 row: green background | 50% edge pixel (orange fg blended with green) | orange foreground
    const W = 9;
    const content = new Uint8ClampedArray(W * 4);
    const matte = new Uint8ClampedArray(W * 4);
    const fg = [240, 120, 40];
    const bg = [0, 200, 0];
    for (let x = 0; x < W; x++) {
      const a = x < 4 ? 0 : x === 4 ? 0.5 : 1;
      for (let k = 0; k < 3; k++) content[x * 4 + k] = Math.round(fg[k] * a + bg[k] * (1 - a));
      content[x * 4 + 3] = 255;
      matte[x * 4 + 3] = Math.round(a * 255);
    }
    const before = Array.from(content.slice(16, 19));
    const r = decontaminatedMatteInPlace(content, matte, W, 1);
    expect(r.pixelsDecontaminated).toBe(1);
    const edge = Array.from(content.slice(16, 20));
    expect(before[1]).toBeGreaterThan(155); // the raw edge pixel is heavily green
    expect(Math.abs(edge[0] - fg[0])).toBeLessThan(6); // unmixed back to the foreground color
    expect(Math.abs(edge[1] - fg[1])).toBeLessThan(6);
    expect(edge[3]).toBe(128); // alpha = content alpha x matte alpha
    expect(content[3]).toBe(0); // background gone
    expect(Array.from(content.slice(32, 36))).toEqual([...fg, 255]); // solid foreground untouched
  });

  it("decontamination is a matte option: persisted, validated, and only used for non-inverted alpha mattes", () => {
    const e = project();
    const id = addVideo(e);
    ok(e.setClipVisual(id, { matte: { sourceId: "matte", invert: false, decontaminate: true } }));
    expect(layerOf(e.timeline, id).matte!.decontaminate).toBe(true);
    expect(deserializeTimeline(serializeTimeline(e.timeline)).clips[id].visual!.matte).toEqual({ sourceId: "matte", invert: false, decontaminate: true });
    expect(() => applyVisualPatch(defaultClipVisual(10, 10), { matte: { sourceId: "m", invert: false, decontaminate: "yes" as never } })).toThrow(InvalidVisualError);
    const { log } = drawWithLog(e.timeline);
    // decontaminated path reads both surfaces back and writes the layer region, instead of destination-in
    expect(log.some((c) => c.surface === "scratch0" && c.op === "getImageData")).toBe(true);
    expect(log.some((c) => c.surface === "scratch0" && c.op === "putImageData")).toBe(true);
    expect(log.some((c) => c.surface === "scratch0" && c.op === "drawImage" && c.gco === "destination-in")).toBe(false);
    ok(e.setClipVisual(id, { matte: { sourceId: "matte", invert: true, decontaminate: true } }));
    expect(drawWithLog(e.timeline).log.some((c) => c.surface === "scratch0" && c.gco === "destination-out")).toBe(true);
  });

  it("masks work on every layer kind: text, graphics, video, images", () => {
    const e = project();
    const text = ok(e.addTextLayer({ text: "Hello", atFrame: 0, durationFrames: 60 })).clip.id;
    const shape = addRectLayer(e);
    const vid = addVideo(e);
    const it = ok(e.addTrack("overlay", "img")).track.id;
    const img = ok(e.insertClip(it, { kind: "overlay", source: { sourceId: "img" }, sourceInFrame: 0, sourceOutFrame: 60 }, 0)).clip.id;
    for (const id of [text, shape, vid, img]) ok(e.addMask(id, "ellipse", { patch: { feather: 4 } }));
    const frame = resolveFrame(e.timeline, 0, ctx());
    expect(frame.layers.length).toBe(4);
    for (const l of frame.layers) {
      expect(l.masks.length).toBe(1);
      expect(maskPlanFor(l).kind).toBe("raster");
    }
    const { log } = drawWithLog(e.timeline);
    expect(log.filter((c) => c.op === "putImageData" && c.surface === "scratch4").length).toBe(4);
  });

  it("feather and expansion are in layer pixels: they scale with the layer and the render scale", () => {
    const e = project();
    const id = addRectLayer(e);
    ok(e.addMask(id, "ellipse", { patch: { feather: 10, expansion: 4 } }));
    ok(e.setClipVisual(id, { transform: { scaleX: 3, scaleY: 3 } }));
    const l = layerOf(e.timeline, id);
    const half = rasterMasksFor(l, multiply(scaleMatrix(0.5), l.matrix))[0];
    expect(half.feather).toBeCloseTo(15);
    expect(half.expansion).toBeCloseTo(6);
  });
});

// ---- background removal bridge -----------------------------------------------------------

describe("background removal -> matte input", () => {
  const fakeImage = (w: number, h: number) => ({ width: w, height: h }) as unknown as CanvasImageSource;
  const provider = (fail = new Set<number>()) => {
    const requested: number[] = [];
    return {
      requested,
      fail,
      getSourceInfo: (id: string) => (SOURCES as Record<string, { width: number; height: number }>)[id],
      getExactFrame: async (r: { sourceFrame: number }) => (requested.push(r.sourceFrame), fakeImage(64, 36)),
    };
  };
  /** Engine stand-in: call n's matte is uniformly n/10, so every stored frame says which engine run produced it. */
  const matteFn = (fail: Set<number>, calls: { n: number }, w = 64, h = 36) => async (): Promise<MatteAlpha> => {
    const n = calls.n++;
    if (fail.has(n)) throw new Error("no subject");
    return { alpha: new Float32Array(w * h).fill(n / 10), alphaWidth: w, alphaHeight: h, modelUsed: "u2netp", confidence: 0.8, warnings: [] };
  };
  const levels = async (chunks: { bytes: Uint8Array }[]) => {
    const track = new MatteTrack(chunks.map((c) => c.bytes));
    const out: number[] = [];
    for (let f = track.firstFrame; f < track.firstFrame + track.frameCount; f++) out.push(Math.round(((await track.decodeFrame(f))[0] / 255) * 10));
    return out;
  };
  const toImage = (_d: Uint8ClampedArray, w: number, h: number) => ({ width: w, height: h }) as unknown as CanvasImageSource & { width: number; height: number };

  it("alpha -> white matte with alpha channel", () => {
    expect(Array.from(alphaToMatteRgba(new Float32Array([0, 0.5, 1.4]), 3, 1))).toEqual([255, 255, 255, 0, 255, 255, 255, 128, 255, 255, 255, 255]);
  });

  it("video: one engine run per SOURCE FRAME -> a matte track; failed frames reuse a neighbour's matte and are reported", async () => {
    const e = project();
    const id = addVideo(e, "v", 10, 20);
    const p = provider();
    const out = await generateClipMatte(p, e.timeline.clips[id], { fps: 30, matteFn: matteFn(new Set([0, 4]), { n: 0 }), toImage });
    expect(p.requested).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(out.kind).toBe("track");
    if (out.kind !== "track") return;
    expect(out).toMatchObject({ firstFrame: 10, frameCount: 10, width: 64, height: 36 });
    // Call 0 failed (leading: takes call 1's matte), call 4 failed (repeats call 3's).
    expect(await levels(out.chunks)).toEqual([1, 1, 2, 3, 3, 5, 6, 7, 8, 9]);
    expect(out.report).toMatchObject({ framesRequested: 10, framesMatted: 8, framesFailed: 2, modelsUsed: ["u2netp"] });
    expect(out.report.warnings.some((w) => w.includes("2 of 10 frames"))).toBe(true);
    expect(out.report.meanConfidence).toBeCloseTo(0.8);
    expect(matteSourceIdFor(e.timeline.clips[id])).toBe("bgmatte:v:10-20");
  });

  it("video: large frames are stored at most 640 px on the long side", async () => {
    const e = project();
    const id = addVideo(e, "v", 0, 3);
    const out = await generateClipMatte(provider(), e.timeline.clips[id], { fps: 30, matteFn: matteFn(new Set(), { n: 0 }, 1280, 720), toImage });
    expect(out).toMatchObject({ kind: "track", width: 640, height: 360, frameCount: 3 });
  });

  it("video: every frame failing is an error; over-long clips are refused up front", async () => {
    const e = project();
    const id = addVideo(e, "v", 0, 5);
    await expect(generateClipMatte(provider(), e.timeline.clips[id], { fps: 30, matteFn: matteFn(new Set([0, 1, 2, 3, 4]), { n: 0 }), toImage })).rejects.toThrow(MatteGenerationError);
    const long = addVideo(e, "v", 0, MAX_MATTE_CLIP_SECONDS * 30 + 1);
    const p = provider();
    await expect(generateClipMatte(p, e.timeline.clips[long], { fps: 30, matteFn: matteFn(new Set(), { n: 0 }), toImage })).rejects.toThrow(/up to 10 minutes/);
    expect(p.requested).toEqual([]);
  });

  it("image: a single matte; nothing matted at all is an error, never a fake success", async () => {
    const e = project();
    const t = ok(e.addTrack("image", "img")).track.id;
    const id = ok(e.insertClip(t, { kind: "image", source: { sourceId: "img" }, durationFrames: 30 } as never, 0)).clip.id;
    const out = await generateClipMatte(provider(), e.timeline.clips[id], { fps: 30, matteFn: matteFn(new Set(), { n: 0 }), toImage });
    expect(out.kind).toBe("still");
    await expect(generateClipMatte(provider(), e.timeline.clips[id], { fps: 30, matteFn: matteFn(new Set([0]), { n: 0 }), toImage })).rejects.toThrow(MatteGenerationError);
  });

  it("cancellation stops between frames; shapes/text can't be background-removed", async () => {
    const e = project();
    const id = addVideo(e);
    const ac = new AbortController();
    ac.abort();
    await expect(generateClipMatte(provider(), e.timeline.clips[id], { fps: 30, signal: ac.signal, matteFn: matteFn(new Set(), { n: 0 }), toImage })).rejects.toThrow(/cancelled/);
    const shapeId = addRectLayer(e);
    expect(canRemoveBackground(e.timeline.clips[shapeId])).toBe(false);
    expect(canRemoveBackground(e.timeline.clips[id])).toBe(true);
  });

  it("frame sequences hold the nearest earlier sample", () => {
    const seq = normalizeSequence([
      { frame: 20, image: "c" },
      { frame: 0, image: "a" },
      { frame: 10, image: "b" },
      { frame: 10, image: "b2" },
    ]);
    expect(seq.map((s) => s.image)).toEqual(["a", "b2", "c"]);
    expect([-5, 0, 9, 10, 19, 99].map((f) => sampleAt(seq, f)!.image)).toEqual(["a", "a", "a", "b2", "b2", "c"]);
    expect(sampleAt([], 3)).toBeNull();
  });
});

// Keeps the Mask type import meaningful for readers of this suite.
export type _MaskForDocs = Mask;
