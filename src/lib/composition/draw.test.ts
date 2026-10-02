import { describe, expect, it } from "vitest";
import { drawResolvedFrame, type Ctx2D } from "./draw";
import { createTimeline } from "../timeline/model";
import { addTrack, insertClip, setClipVisual } from "../timeline/operations";
import { resolveFrame } from "./resolve";
import { fakeContext } from "./test-helpers";

/**
 * Canvas 2D isn't available in Node, so these tests drive drawResolvedFrame
 * with a recording context and assert on the exact call sequence: the parts
 * that matter for correctness here are WHICH compositing ops run in WHICH
 * order on WHICH surface, and the crop source-rect math. Actual pixel output
 * is verified in the browser (see COMPOSITION_ARCHITECTURE.md §9).
 */
type Call = { surface: string; op: string; args: unknown[]; gco?: string; alpha?: number };

function recordingCtx(surface: string, log: Call[], width: number, height: number): Ctx2D {
  const state = { globalCompositeOperation: "source-over", globalAlpha: 1 };
  const canvas = { width, height, __surface: surface };
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "canvas") return canvas;
      if (prop in state) return state[prop as keyof typeof state];
      return (...args: unknown[]) => log.push({ surface, op: prop, args, gco: state.globalCompositeOperation, alpha: state.globalAlpha });
    },
    set(_t, prop: string, value) {
      if (prop in state) (state as Record<string, unknown>)[prop] = value;
      return true;
    },
  };
  return new Proxy({}, handler) as Ctx2D;
}

function scene() {
  let tl = createTimeline(30, { width: 100, height: 100, background: "transparent" });
  const top = addTrack(tl, "overlay", "top");
  tl = top.timeline;
  const bottom = addTrack(tl, "video", "bottom");
  tl = bottom.timeline;
  const o = insertClip(tl, top.track.id, { kind: "overlay", source: { sourceId: "fg" }, sourceInFrame: 0, sourceOutFrame: 10 }, 0, { fit: "fill", crop: { left: 0.5 } });
  tl = o.timeline;
  const v = insertClip(tl, bottom.track.id, { kind: "video", source: { sourceId: "bg" }, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
  tl = v.timeline;
  return { tl, overlay: o.clip.id, video: v.clip.id };
}

const SOURCES = { fg: { width: 200, height: 200 }, bg: { width: 100, height: 100 }, m: { width: 50, height: 50 } };

describe("drawResolvedFrame", () => {
  it("transparent background clears instead of filling; layers composite with their opacity", () => {
    const { tl, overlay, video } = scene();
    const log: Call[] = [];
    const ctx = recordingCtx("main", log, 100, 100);
    const t2 = setClipVisual(tl, overlay, { opacity: 0.25, blendMode: "screen" });
    const frame = resolveFrame(t2, 0, fakeContext(SOURCES));
    const img = { width: 200, height: 200 } as unknown as CanvasImageSource;
    const bg = { width: 100, height: 100 } as unknown as CanvasImageSource;
    drawResolvedFrame(ctx, frame, new Map([[overlay, { image: img }], [video, { image: bg }]]), { renderScale: 1, smoothing: "high", getScratch: () => { throw new Error("no matte"); } });
    expect(log.some((c) => c.op === "fillRect")).toBe(false);
    const draws = log.filter((c) => c.op === "drawImage");
    expect(draws.map((d) => d.args[0])).toEqual([bg, img]); // back-to-front
    expect(draws[1]).toMatchObject({ gco: "screen", alpha: 0.25 });
  });

  it("crop maps through the delivered image's real size (proxy frames line up)", () => {
    const { tl, overlay } = scene();
    const frame = resolveFrame(tl, 0, fakeContext(SOURCES));
    const log: Call[] = [];
    // Provider hands back a half-resolution proxy (100x100) of a 200x200 source.
    const proxy = { width: 100, height: 100 } as unknown as CanvasImageSource;
    drawResolvedFrame(recordingCtx("main", log, 100, 100), { ...frame, layers: frame.layers.filter((l) => l.clipId === overlay) }, new Map([[overlay, { image: proxy }]]), {
      renderScale: 1,
      smoothing: "high",
      getScratch: () => { throw new Error(); },
    });
    const d = log.find((c) => c.op === "drawImage")!;
    // left 50% crop: source rect in proxy px, dest rect in content px.
    expect(d.args.slice(1)).toEqual([50, 0, 50, 100, 100, 0, 100, 200]);
  });

  it("matte isolates the layer on scratch (destination-in) before compositing onto main", () => {
    const { tl, overlay } = scene();
    const t2 = setClipVisual(tl, overlay, { matte: { sourceId: "m", invert: false }, opacity: 0.5 });
    const frame = resolveFrame(t2, 0, fakeContext(SOURCES));
    const log: Call[] = [];
    const scratch = recordingCtx("scratch", log, 100, 100);
    const img = { width: 200, height: 200 } as unknown as CanvasImageSource;
    const matte = { width: 50, height: 50 } as unknown as CanvasImageSource;
    drawResolvedFrame(recordingCtx("main", log, 100, 100), { ...frame, layers: frame.layers.filter((l) => l.clipId === overlay) }, new Map([[overlay, { image: img, matte }]]), {
      renderScale: 1,
      smoothing: "high",
      getScratch: () => scratch,
    });
    const draws = log.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(3);
    expect(draws[0]).toMatchObject({ surface: "scratch", gco: "source-over", alpha: 1 });
    expect(draws[0].args[0]).toBe(img);
    expect(draws[1]).toMatchObject({ surface: "scratch", gco: "destination-in" });
    expect(draws[1].args.slice(0, 5)).toEqual([matte, 25, 0, 25, 50]); // crop mapped into matte px
    expect(draws[2]).toMatchObject({ surface: "main", gco: "source-over", alpha: 0.5 }); // opacity applied AFTER matting
  });

  it("matted layer without matte pixels is skipped, never drawn unmatted", () => {
    const { tl, overlay } = scene();
    const t2 = setClipVisual(tl, overlay, { matte: { sourceId: "m", invert: true } });
    const frame = resolveFrame(t2, 0, fakeContext(SOURCES));
    const log: Call[] = [];
    const stats = drawResolvedFrame(recordingCtx("main", log, 100, 100), { ...frame, layers: frame.layers.filter((l) => l.clipId === overlay) }, new Map([[overlay, { image: {} as CanvasImageSource }]]), {
      renderScale: 1,
      smoothing: "high",
      getScratch: () => { throw new Error(); },
    });
    expect(stats.skipped).toEqual([overlay]);
    expect(log.filter((c) => c.op === "drawImage")).toHaveLength(0);
  });

  it("renderScale is applied as the base transform", () => {
    const { tl, video } = scene();
    const frame = resolveFrame(tl, 0, fakeContext(SOURCES));
    const log: Call[] = [];
    drawResolvedFrame(recordingCtx("main", log, 25, 25), { ...frame, layers: frame.layers.filter((l) => l.clipId === video) }, new Map([[video, { image: {} as CanvasImageSource }]]), {
      renderScale: 0.25,
      smoothing: "low",
      getScratch: () => { throw new Error(); },
    });
    const st = log.filter((c) => c.op === "setTransform").pop()!;
    expect(st.args).toEqual([0.25, 0, 0, 0.25, 0, 0]);
  });
});
