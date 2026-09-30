import { describe, it, expect } from "vitest";
import { ManualRefinementEngine, BrushMode } from "./manual-refinement-engine";

const WIDTH = 40;
const HEIGHT = 40;

function makeUniformAlpha(value: number): Float32Array {
  return new Float32Array(WIDTH * HEIGHT).fill(value);
}

function makeFlatRgba(gray: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("ManualRefinementEngine — painting", () => {
  it("painting FOREGROUND pushes touched pixels toward opaque and leaves everything else exactly as the AI predicted it", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    const region = engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    expect(region).not.toBeNull();

    const effective = engine.getEffectiveAlpha();
    expect(effective[20 * WIDTH + 20]).toBeCloseTo(1, 5);
    expect(effective[0]).toBe(0); // far corner, untouched by the stroke
  });

  it("painting BACKGROUND pushes touched pixels toward transparent", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(1), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Background, { size: 6, hardness: 1, opacity: 1 });

    const effective = engine.getEffectiveAlpha();
    expect(effective[20 * WIDTH + 20]).toBeCloseTo(0, 5);
    expect(effective[0]).toBe(1);
  });

  it("partial opacity builds up gradually across repeated strokes rather than jumping straight to the target", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 0.5 });
    const afterOne = engine.getEffectiveAlpha()[20 * WIDTH + 20];
    expect(afterOne).toBeCloseTo(0.5, 5);

    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 0.5 });
    const afterTwo = engine.getEffectiveAlpha()[20 * WIDTH + 20];
    expect(afterTwo).toBeGreaterThan(afterOne);
    expect(afterTwo).toBeLessThan(1);
  });
});

describe("ManualRefinementEngine — undo/redo", () => {
  it("UNDO reverts exactly to the pre-stroke state", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    const before = engine.getEffectiveAlpha();
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    expect(engine.canUndo()).toBe(true);

    const region = engine.undo();
    expect(region).not.toBeNull();
    expect(Array.from(engine.getEffectiveAlpha())).toEqual(Array.from(before));
    expect(engine.canUndo()).toBe(false);
  });

  it("REDO reapplies exactly the state undo reverted", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    const afterStroke = engine.getEffectiveAlpha();

    engine.undo();
    expect(engine.canRedo()).toBe(true);
    engine.redo();

    expect(Array.from(engine.getEffectiveAlpha())).toEqual(Array.from(afterStroke));
    expect(engine.canRedo()).toBe(false);
  });

  it("a new stroke after an undo clears the redo stack", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    engine.undo();
    expect(engine.canRedo()).toBe(true);

    engine.applyStroke([{ x: 10, y: 10 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    expect(engine.canRedo()).toBe(false);
  });

  it("undo/redo only ever touches the returned region, never the whole image", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 3, hardness: 1, opacity: 1 });
    const region = engine.undo();
    expect(region).not.toBeNull();
    expect(region!.maxX - region!.minX).toBeLessThan(WIDTH);
    expect(region!.maxY - region!.minY).toBeLessThan(HEIGHT);
  });
});

describe("ManualRefinementEngine — reset", () => {
  it("RESET LOCAL REFINEMENT discards every manual edit and reverts fully to the AI output", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.3), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 5, y: 5 }], BrushMode.Foreground, { size: 3, hardness: 1, opacity: 1 });
    engine.applyStroke([{ x: 30, y: 30 }], BrushMode.Background, { size: 3, hardness: 1, opacity: 1 });
    expect(engine.hasManualEdits()).toBe(true);

    engine.reset();

    expect(engine.hasManualEdits()).toBe(false);
    expect(Array.from(engine.getEffectiveAlpha())).toEqual(Array.from(engine.getBaseAlpha()));
  });

  it("reset itself is undoable", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.3), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 5, y: 5 }], BrushMode.Foreground, { size: 3, hardness: 1, opacity: 1 });
    const beforeReset = engine.getEffectiveAlpha();

    engine.reset();
    engine.undo();

    expect(Array.from(engine.getEffectiveAlpha())).toEqual(Array.from(beforeReset));
  });
});

describe("ManualRefinementEngine — save/reload", () => {
  it("SAVE serializes the current layer state faithfully", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.2), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });

    const data = engine.serialize();
    expect(data.width).toBe(WIDTH);
    expect(data.height).toBe(HEIGHT);
    expect(data.baseAlpha.length).toBe(WIDTH * HEIGHT);
    expect(data.baseAlpha[0]).toBeCloseTo(0.2, 5);
    expect(data.touched[20 * WIDTH + 20]).toBe(1);
  });

  it("RELOAD reproduces the exact same effective alpha in a fresh engine instance", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.2), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    engine.applyStroke([{ x: 10, y: 30 }], BrushMode.Background, { size: 4, hardness: 1, opacity: 0.6 });

    const data = engine.serialize();
    const reloaded = ManualRefinementEngine.deserialize(data);

    expect(Array.from(reloaded.getEffectiveAlpha())).toEqual(Array.from(engine.getEffectiveAlpha()));
    expect(Array.from(reloaded.getBaseAlpha())).toEqual(Array.from(engine.getBaseAlpha()));
  });

  it("a reloaded engine starts with a fresh (empty) undo stack — history is a session log, not part of the saved edit", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.2), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    const reloaded = ManualRefinementEngine.deserialize(engine.serialize());
    expect(reloaded.canUndo()).toBe(false);
  });
});

describe("ManualRefinementEngine — Eraser vs Restore", () => {
  it("ERASER gradually blends the override back toward the AI's own alpha", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    expect(engine.getEffectiveAlpha()[20 * WIDTH + 20]).toBeCloseTo(1, 5);

    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Eraser, { size: 6, hardness: 1, opacity: 0.5 });
    const partiallyErased = engine.getEffectiveAlpha()[20 * WIDTH + 20];
    expect(partiallyErased).toBeGreaterThan(0);
    expect(partiallyErased).toBeLessThan(1);
  });

  it("RESTORE fully discards the override in one stroke regardless of opacity", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Restore, { size: 6, hardness: 1, opacity: 0.1 });

    expect(engine.getEffectiveAlpha()[20 * WIDTH + 20]).toBe(0);
    expect(engine.hasManualEdits()).toBe(false);
  });
});

describe("ManualRefinementEngine — RefineEdge", () => {
  it("reruns local guided refinement within the brush footprint using the source image as guidance", () => {
    // A hard image edge (bright/dark) with a slightly-off alpha step offset
    // from it — a plausible AI mistake a user might want to nudge back into
    // alignment with the real edge.
    const rgba = makeFlatRgba(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 20; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
    }
    const alpha = makeUniformAlpha(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 20; x < WIDTH; x++) alpha[y * WIDTH + x] = 1;
    // Introduce noise right at the boundary the refine-edge brush should clean up.
    alpha[20 * WIDTH + 19] = 0.5;
    alpha[20 * WIDTH + 20] = 0.5;

    const engine = new ManualRefinementEngine(alpha, WIDTH, HEIGHT);
    const before = engine.getEffectiveAlpha().slice();
    const region = engine.applyStroke([{ x: 20, y: 20 }], BrushMode.RefineEdge, { size: 5, hardness: 1, opacity: 1 }, rgba);

    expect(region).not.toBeNull();
    const after = engine.getEffectiveAlpha();
    expect(after[20 * WIDTH + 20]).not.toBe(before[20 * WIDTH + 20]);
    for (const v of after) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("ManualRefinementEngine — feather", () => {
  it("a feathered stroke smooths its own dirty region's transition compared to an unfeathered one", () => {
    const engineHard = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engineHard.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 5, hardness: 1, opacity: 1, feather: 0 });

    const engineSoft = new ManualRefinementEngine(makeUniformAlpha(0), WIDTH, HEIGHT);
    engineSoft.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 5, hardness: 1, opacity: 1, feather: 4 });

    // Just past the hard brush's own radius, the unfeathered stroke is
    // exactly 0 (untouched); the feathered one has smeared some alpha out
    // beyond the original radius.
    const edgeIndex = 20 * WIDTH + 26;
    expect(engineHard.getEffectiveAlpha()[edgeIndex]).toBe(0);
    expect(engineSoft.getEffectiveAlpha()[edgeIndex]).toBeGreaterThan(0);
  });
});

describe("ManualRefinementEngine — non-destructiveness and local updates", () => {
  it("never mutates the baseAlpha array passed into the constructor", () => {
    const original = makeUniformAlpha(0.4);
    const originalCopy = original.slice();
    const engine = new ManualRefinementEngine(original, WIDTH, HEIGHT);
    engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 6, hardness: 1, opacity: 1 });

    expect(Array.from(original)).toEqual(Array.from(originalCopy));
    expect(Array.from(engine.getBaseAlpha())).toEqual(Array.from(originalCopy));
  });

  it("getBaseAlpha() is immune to external mutation of the returned array", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.4), WIDTH, HEIGHT);
    const base = engine.getBaseAlpha();
    base[0] = 999;
    expect(engine.getBaseAlpha()[0]).toBeCloseTo(0.4, 5);
  });

  it("a stroke's dirty region never covers the whole image, and pixels outside it are provably untouched", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.4), WIDTH, HEIGHT);
    const region = engine.applyStroke([{ x: 20, y: 20 }], BrushMode.Foreground, { size: 4, hardness: 1, opacity: 1 });
    expect(region).not.toBeNull();
    expect((region!.maxX - region!.minX + 1) * (region!.maxY - region!.minY + 1)).toBeLessThan(WIDTH * HEIGHT);

    const effective = engine.getEffectiveAlpha();
    // Far corner, well outside the brush's radius.
    expect(effective[0]).toBeCloseTo(0.4, 5);
  });

  it("returns null (and records no history) for a stroke that lands entirely off-canvas", () => {
    const engine = new ManualRefinementEngine(makeUniformAlpha(0.4), WIDTH, HEIGHT);
    const region = engine.applyStroke([{ x: -100, y: -100 }], BrushMode.Foreground, { size: 4, hardness: 1, opacity: 1 });
    expect(region).toBeNull();
    expect(engine.canUndo()).toBe(false);
  });
});
