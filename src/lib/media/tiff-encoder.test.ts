import { describe, it, expect } from "vitest";
import { encodeRgbaToTiff, decodeTiffToRgba } from "./tiff-encoder";

/** Hand-rolled TIFF reader — just enough to check what the encoder wrote, independent of any decoding library. */
function readTiff(view: DataView) {
  expect(view.getUint8(0)).toBe(0x49);
  expect(view.getUint8(1)).toBe(0x49);
  expect(view.getUint16(2, true)).toBe(42);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  const tags: Record<number, { type: number; count: number; value: number }> = {};
  for (let i = 0; i < entryCount; i++) {
    const base = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(base, true);
    const type = view.getUint16(base + 2, true);
    const count = view.getUint32(base + 4, true);
    const value = view.getUint32(base + 8, true);
    tags[tag] = { type, count, value };
  }
  return tags;
}

describe("encodeRgbaToTiff", () => {
  it("round-trips width, height, and pixel data for a small image", () => {
    const width = 3;
    const height = 2;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = i * 10;
      rgba[i * 4 + 1] = 200;
      rgba[i * 4 + 2] = 50;
      rgba[i * 4 + 3] = i % 2 === 0 ? 255 : 0; // alternating opaque/transparent
    }

    const blob = encodeRgbaToTiff(rgba, width, height);
    expect(blob.type).toBe("image/tiff");

    return blob.arrayBuffer().then((buf) => {
      const view = new DataView(buf);
      const tags = readTiff(view);

      expect(tags[256].value).toBe(width); // ImageWidth
      expect(tags[257].value).toBe(height); // ImageLength
      expect(tags[277].value).toBe(4); // SamplesPerPixel
      expect(tags[338].value).toBe(2); // ExtraSamples = unassociated alpha
      expect(tags[259].value).toBe(1); // Compression = none

      const stripOffset = tags[273].value;
      const stripByteCount = tags[279].value;
      expect(stripByteCount).toBe(width * height * 4);

      const pixels = new Uint8Array(buf, stripOffset, stripByteCount);
      expect(Array.from(pixels)).toEqual(Array.from(rgba));
    });
  });

  it("rejects a pixel buffer smaller than width*height*4", () => {
    expect(() => encodeRgbaToTiff(new Uint8ClampedArray(4), 10, 10)).toThrow();
  });
});

describe("decodeTiffToRgba", () => {
  it("round-trips a real encodeRgbaToTiff output exactly", () => {
    const width = 4;
    const height = 3;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = (i * 17) % 256;
      rgba[i * 4 + 1] = (i * 31) % 256;
      rgba[i * 4 + 2] = (i * 53) % 256;
      rgba[i * 4 + 3] = i < width * height / 2 ? 255 : 0;
    }

    return encodeRgbaToTiff(rgba, width, height)
      .arrayBuffer()
      .then((buf) => {
        const decoded = decodeTiffToRgba(buf);
        expect(decoded).not.toBeNull();
        expect(decoded!.width).toBe(width);
        expect(decoded!.height).toBe(height);
        expect(decoded!.hasAlpha).toBe(true);
        expect(Array.from(decoded!.rgba)).toEqual(Array.from(rgba));
      });
  });

  it("returns null for a non-TIFF buffer", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).buffer;
    expect(decodeTiffToRgba(buf)).toBeNull();
  });
});
