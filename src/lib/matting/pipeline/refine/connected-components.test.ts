import { describe, it, expect } from "vitest";
import { labelConnectedComponents } from "./connected-components";

function mask(width: number, rows: string[]): Uint8Array {
  const height = rows.length;
  const m = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      m[y * width + x] = rows[y][x] === "1" ? 1 : 0;
    }
  }
  return m;
}

describe("labelConnectedComponents", () => {
  it("labels an all-zero mask as having no components", () => {
    const m = mask(3, ["000", "000", "000"]);
    const result = labelConnectedComponents(m, 3, 3);
    expect(result.sizes).toEqual([]);
    expect(Array.from(result.labels).every((v) => v === -1)).toBe(true);
  });

  it("labels a single fully-connected blob as one component with the correct size", () => {
    const m = mask(3, ["111", "111", "111"]);
    const result = labelConnectedComponents(m, 3, 3);
    expect(result.sizes).toEqual([9]);
    expect(result.pixelsByLabel[0].length).toBe(9);
  });

  it("separates two diagonally-adjacent blobs into different components (4-connectivity, not 8)", () => {
    const m = mask(2, ["10", "01"]);
    const result = labelConnectedComponents(m, 2, 2);
    expect(result.sizes.length).toBe(2);
    expect(result.sizes).toEqual([1, 1]);
  });

  it("correctly distinguishes a border-touching component from an enclosed one", () => {
    // 5x5: a ring of 1s around the border, and a separate isolated 1 in the
    // exact center that is NOT connected to the ring (surrounded by 0s).
    const m = mask(5, ["11111", "10001", "10001", "10001", "11111"]);
    const result = labelConnectedComponents(m, 5, 5);
    expect(result.sizes.length).toBe(1); // the ring is one connected component; the 0s in the middle aren't part of `mask`
    expect(result.touchesBorder[0]).toBe(true);
  });

  it("flags an enclosed component (a hole candidate) as not touching the border", () => {
    // A single isolated pixel in the exact center of a 5x5 grid, fully
    // surrounded by non-mask pixels — mirrors how cleanup.ts distinguishes
    // a genuinely enclosed background "hole" from the real exterior
    // background, which always touches the border.
    const isolated = mask(5, ["00000", "00000", "00100", "00000", "00000"]);
    const result = labelConnectedComponents(isolated, 5, 5);
    expect(result.sizes).toEqual([1]);
    expect(result.touchesBorder[0]).toBe(false);
  });

  it("reports every pixel index belonging to a component via pixelsByLabel", () => {
    const m = mask(3, ["100", "000", "001"]);
    const result = labelConnectedComponents(m, 3, 3);
    expect(result.sizes).toEqual([1, 1]);
    const allPixels = result.pixelsByLabel.flat().sort((a, b) => a - b);
    expect(allPixels).toEqual([0, 8]); // top-left (index 0) and bottom-right (index 8)
  });
});
