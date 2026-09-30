import { describe, it, expect } from "vitest";
import { compositePreview, renderEdgePreview, PreviewBackgroundMode } from "./preview-compositor";
import { TrimapLabel } from "./trimap";

const WIDTH = 16;
const HEIGHT = 16;

function makeFlatRgba(r: number, g: number, b: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("compositePreview", () => {
  it("TRANSPARENT mode passes the RGB through and encodes real alpha in the 4th channel", () => {
    const rgba = makeFlatRgba(10, 20, 30);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.Transparent });
    expect(result.rgba[0]).toBe(10);
    expect(result.rgba[1]).toBe(20);
    expect(result.rgba[2]).toBe(30);
    expect(result.rgba[3]).toBe(128); // round(0.5*255)
  });

  it("ORIGINAL mode ignores alpha entirely and returns the unmodified source, fully opaque", () => {
    const rgba = makeFlatRgba(200, 100, 50);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0); // would be fully transparent under any other mode
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.Original });
    expect(result.rgba[0]).toBe(200);
    expect(result.rgba[1]).toBe(100);
    expect(result.rgba[2]).toBe(50);
    expect(result.rgba[3]).toBe(255);
  });

  it("BLACK mode composites toward black in proportion to (1 - alpha)", () => {
    const rgba = makeFlatRgba(200, 200, 200);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.25);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.Black });
    expect(result.rgba[0]).toBe(Math.round(200 * 0.25));
    expect(result.rgba[3]).toBe(255); // flattened opaque
  });

  it("WHITE mode composites toward white in proportion to (1 - alpha)", () => {
    const rgba = makeFlatRgba(50, 50, 50);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.White });
    expect(result.rgba[0]).toBe(Math.round(50 * 0.5 + 255 * 0.5));
  });

  it("CHECKERBOARD mode alternates between the two checker colours at fully transparent pixels", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0); // fully transparent -> pure checker colour shows through
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, {
      backgroundMode: PreviewBackgroundMode.Checkerboard,
      checkerSize: 4,
      checkerLight: [255, 255, 255],
      checkerDark: [200, 200, 200],
    });
    const at = (x: number, y: number) => result.rgba[(y * WIDTH + x) * 4];
    expect(at(0, 0)).toBe(255); // square (0,0) -> light
    expect(at(4, 0)).toBe(200); // next square over -> dark
    expect(at(0, 4)).toBe(200); // next square down -> dark
    expect(at(4, 4)).toBe(255); // diagonal neighbor -> light again
  });

  it("GRAY mode composites toward a configurable gray in proportion to (1 - alpha)", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.Gray, grayColor: [140, 140, 140] });
    expect(result.rgba[0]).toBe(140);
  });

  it("CUSTOM mode uses a solid custom colour when no background image is supplied", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.Custom, customColor: [10, 20, 30] });
    expect(result.rgba[0]).toBe(10);
    expect(result.rgba[1]).toBe(20);
    expect(result.rgba[2]).toBe(30);
  });

  it("CUSTOM mode samples a supplied background image instead of the solid colour", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const bgImage = makeFlatRgba(90, 91, 92);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, {
      backgroundMode: PreviewBackgroundMode.Custom,
      customBackgroundImage: { rgba: bgImage, width: WIDTH, height: HEIGHT },
    });
    expect(result.rgba[0]).toBe(90);
    expect(result.rgba[1]).toBe(91);
    expect(result.rgba[2]).toBe(92);
  });

  it("HIGH_CONTRAST_DIAGNOSTIC mode alternates between two saturated diagnostic colours", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, {
      backgroundMode: PreviewBackgroundMode.HighContrastDiagnostic,
      diagnosticCheckerSize: 4,
      diagnosticColorA: [255, 0, 255],
      diagnosticColorB: [0, 255, 0],
    });
    const at = (x: number, y: number) => [result.rgba[(y * WIDTH + x) * 4], result.rgba[(y * WIDTH + x) * 4 + 1], result.rgba[(y * WIDTH + x) * 4 + 2]];
    expect(at(0, 0)).toEqual([255, 0, 255]);
    expect(at(4, 0)).toEqual([0, 255, 0]);
  });

  it("MATTE_ONLY mode renders the raw alpha as a grayscale image, ignoring rgba entirely", () => {
    const rgba = makeFlatRgba(200, 10, 10); // a strong colour that must NOT leak into matte-only output
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.4);
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, { backgroundMode: PreviewBackgroundMode.MatteOnly });
    const expected = Math.round(0.4 * 255);
    expect(result.rgba[0]).toBe(expected);
    expect(result.rgba[1]).toBe(expected);
    expect(result.rgba[2]).toBe(expected);
    expect(result.rgba[3]).toBe(255);
  });

  it("ALPHA_VISUALIZATION mode renders a deterministic false-colour ramp: blue at 0, green at 0.5, red at 1", () => {
    const rgba = makeFlatRgba(0, 0, 0);
    const alpha = new Float32Array([0, 0.5, 1]);
    const result = compositePreview(rgba, alpha, 3, 1, { backgroundMode: PreviewBackgroundMode.AlphaVisualization });
    expect([result.rgba[0], result.rgba[1], result.rgba[2]]).toEqual([0, 0, 255]); // alpha 0 -> blue
    expect([result.rgba[4], result.rgba[5], result.rgba[6]]).toEqual([0, 255, 0]); // alpha 0.5 -> green
    expect([result.rgba[8], result.rgba[9], result.rgba[10]]).toEqual([255, 0, 0]); // alpha 1 -> red
  });

  it("restricts output to the given region instead of the full image", () => {
    const rgba = makeFlatRgba(10, 10, 10);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);
    const region = { minX: 2, minY: 2, maxX: 5, maxY: 5 };
    const result = compositePreview(rgba, alpha, WIDTH, HEIGHT, {}, region);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.rgba.length).toBe(4 * 4 * 4);
    expect(result.minX).toBe(2);
    expect(result.minY).toBe(2);
  });
});

describe("renderEdgePreview", () => {
  it("highlights UNKNOWN trimap pixels and dims everything else", () => {
    const rgba = makeFlatRgba(100, 100, 100);
    const trimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Foreground);
    trimap[5 * WIDTH + 5] = TrimapLabel.Unknown;

    const result = renderEdgePreview(rgba, trimap, WIDTH, HEIGHT, { highlightColor: [255, 0, 0], highlightStrength: 1, dimOthers: 0.5 });

    const highlighted = (5 * WIDTH + 5) * 4;
    expect(result.rgba[highlighted]).toBe(255); // fully blended to the highlight colour at strength 1
    expect(result.rgba[highlighted + 1]).toBe(0);

    const dimmed = 0;
    expect(result.rgba[dimmed]).toBe(50); // 100 * (1 - 0.5)
  });
});
