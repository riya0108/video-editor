/**
 * Minimal, dependency-free baseline TIFF encoder for straight-alpha RGBA
 * pixel data. No browser exposes a native TIFF canvas encoder the way PNG
 * and (on modern browsers) WebP are — `canvas.toBlob("image/tiff")` isn't a
 * thing anywhere — so this is a small from-scratch implementation of just
 * enough of the TIFF 6.0 baseline spec to round-trip real alpha: a single
 * uncompressed strip, PhotometricInterpretation=RGB, ExtraSamples=2
 * (unassociated/straight alpha), matching the non-premultiplied alpha
 * `CanvasRenderingContext2D.getImageData()` always returns — no
 * premultiply/unpremultiply conversion needed.
 */

const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  ResolutionUnit: 296,
  ExtraSamples: 338,
} as const;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Fits directly in the 4-byte value slot (used when `externalBytes` is absent). */
  inlineValue?: number;
  /** Values too large for the inline slot (arrays, rationals) — stored after the IFD and referenced by offset. */
  externalBytes?: Uint8Array;
}

function shortsBytes(values: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return new Uint8Array(view.buffer);
}

function rationalBytes(numerator: number, denominator: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, numerator, true);
  view.setUint32(4, denominator, true);
  return new Uint8Array(view.buffer);
}

/** Encodes straight-alpha RGBA pixel data (as returned by `getImageData`) as an uncompressed baseline TIFF. */
export function encodeRgbaToTiff(data: Uint8ClampedArray | Uint8Array, width: number, height: number): Blob {
  const pixelBytes = width * height * 4;
  if (data.length < pixelBytes) throw new Error("Pixel buffer is smaller than width*height*4.");

  const HEADER_SIZE = 8;

  // Tags must appear in ascending numeric order per the TIFF 6.0 spec.
  const entries: IfdEntry[] = [
    { tag: TAG.ImageWidth, type: TYPE_LONG, count: 1, inlineValue: width },
    { tag: TAG.ImageLength, type: TYPE_LONG, count: 1, inlineValue: height },
    { tag: TAG.BitsPerSample, type: TYPE_SHORT, count: 4, externalBytes: shortsBytes([8, 8, 8, 8]) },
    { tag: TAG.Compression, type: TYPE_SHORT, count: 1, inlineValue: 1 },
    { tag: TAG.PhotometricInterpretation, type: TYPE_SHORT, count: 1, inlineValue: 2 },
    { tag: TAG.StripOffsets, type: TYPE_LONG, count: 1, inlineValue: 0 }, // patched once the strip's real offset is known
    { tag: TAG.SamplesPerPixel, type: TYPE_SHORT, count: 1, inlineValue: 4 },
    { tag: TAG.RowsPerStrip, type: TYPE_LONG, count: 1, inlineValue: height },
    { tag: TAG.StripByteCounts, type: TYPE_LONG, count: 1, inlineValue: pixelBytes },
    { tag: TAG.XResolution, type: TYPE_RATIONAL, count: 1, externalBytes: rationalBytes(72, 1) },
    { tag: TAG.YResolution, type: TYPE_RATIONAL, count: 1, externalBytes: rationalBytes(72, 1) },
    { tag: TAG.ResolutionUnit, type: TYPE_SHORT, count: 1, inlineValue: 2 },
    // 2 = unassociated (straight) alpha — matches getImageData's non-premultiplied output.
    { tag: TAG.ExtraSamples, type: TYPE_SHORT, count: 1, inlineValue: 2 },
  ];

  const ifdSize = 2 + entries.length * 12 + 4;
  const externalStart = HEADER_SIZE + ifdSize;

  const ifd = new DataView(new ArrayBuffer(ifdSize));
  ifd.setUint16(0, entries.length, true);

  let externalOffset = externalStart;
  const externalChunks: Uint8Array[] = [];
  let stripOffsetEntryBase = -1;

  entries.forEach((entry, i) => {
    const base = 2 + i * 12;
    ifd.setUint16(base, entry.tag, true);
    ifd.setUint16(base + 2, entry.type, true);
    ifd.setUint32(base + 4, entry.count, true);
    if (entry.tag === TAG.StripOffsets) stripOffsetEntryBase = base;
    if (entry.externalBytes) {
      ifd.setUint32(base + 8, externalOffset, true);
      externalChunks.push(entry.externalBytes);
      externalOffset += entry.externalBytes.length;
    } else {
      ifd.setUint32(base + 8, entry.inlineValue ?? 0, true);
    }
  });
  ifd.setUint32(2 + entries.length * 12, 0, true); // no next IFD

  const externalBytes = new Uint8Array(externalOffset - externalStart);
  let pos = 0;
  for (const chunk of externalChunks) {
    externalBytes.set(chunk, pos);
    pos += chunk.length;
  }

  const stripOffset = externalStart + externalBytes.length;
  ifd.setUint32(stripOffsetEntryBase + 8, stripOffset, true);

  const header = new DataView(new ArrayBuffer(HEADER_SIZE));
  header.setUint8(0, 0x49);
  header.setUint8(1, 0x49); // "II" — little-endian byte order
  header.setUint16(2, 42, true); // TIFF magic number
  header.setUint32(4, HEADER_SIZE, true); // first (only) IFD starts right after the header

  // Copy into a fresh, plain-ArrayBuffer-backed Uint8Array — `data` may be a
  // Uint8ClampedArray or a typed array over a generically-typed
  // ArrayBufferLike, neither of which Blob's constructor accepts directly.
  const pixels = new Uint8Array(pixelBytes);
  pixels.set(data.subarray(0, pixelBytes));

  return new Blob(
    [new Uint8Array(header.buffer), new Uint8Array(ifd.buffer), externalBytes, pixels],
    { type: "image/tiff" },
  );
}

export interface DecodedTiff {
  width: number;
  height: number;
  /** True when ExtraSamples declares an alpha channel (associated or unassociated) — mirrors what encodeRgbaToTiff always writes. */
  hasAlpha: boolean;
  /** Straight RGBA, one row after another — already what analyzeRgba expects, no unpacking needed since this reader only understands the uncompressed 8-bit-per-sample layout encodeRgbaToTiff produces. */
  rgba: Uint8Array;
}

/**
 * Reads back exactly what `encodeRgbaToTiff` writes — baseline, little-
 * endian, uncompressed, 8-bit RGB(+A) in a single strip. Not a general TIFF
 * decoder (no browser has one to fall back on either — `createImageBitmap`
 * can't decode TIFF at all, which is exactly why export-validation.ts needs
 * this): used only to verify this app's own TIFF exports actually contain
 * the alpha and dimensions they claim to. Returns null for anything outside
 * that shape (compressed, tiled, big-endian, etc.) rather than guessing.
 */
export function decodeTiffToRgba(buffer: ArrayBuffer): DecodedTiff | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return null;
  if (view.getUint16(2, little) !== 42) return null;

  const ifdOffset = view.getUint32(4, little);
  if (ifdOffset + 2 > buffer.byteLength) return null;
  const entryCount = view.getUint16(ifdOffset, little);

  const tags = new Map<number, { type: number; count: number; value: number }>();
  for (let i = 0; i < entryCount; i++) {
    const base = ifdOffset + 2 + i * 12;
    if (base + 12 > buffer.byteLength) return null;
    tags.set(view.getUint16(base, little), {
      type: view.getUint16(base + 2, little),
      count: view.getUint32(base + 4, little),
      value: view.getUint32(base + 8, little),
    });
  }

  const width = tags.get(TAG.ImageWidth)?.value;
  const height = tags.get(TAG.ImageLength)?.value;
  const compression = tags.get(TAG.Compression)?.value ?? 1;
  const samplesPerPixel = tags.get(TAG.SamplesPerPixel)?.value ?? 1;
  const stripOffset = tags.get(TAG.StripOffsets)?.value;
  const extraSamples = tags.get(TAG.ExtraSamples);
  if (width === undefined || height === undefined || stripOffset === undefined) return null;
  if (compression !== 1) return null; // uncompressed only

  const hasAlpha = samplesPerPixel >= 4 && !!extraSamples;
  const pixelCount = width * height;
  const strideSamples = samplesPerPixel;
  const stripBytes = pixelCount * strideSamples;
  if (stripOffset + stripBytes > buffer.byteLength) return null;

  const raw = new Uint8Array(buffer, stripOffset, stripBytes);
  const rgba = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const si = i * strideSamples;
    const di = i * 4;
    rgba[di] = raw[si];
    rgba[di + 1] = raw[si + 1];
    rgba[di + 2] = raw[si + 2];
    rgba[di + 3] = hasAlpha ? raw[si + 3] : 255;
  }

  return { width, height, hasAlpha, rgba };
}
