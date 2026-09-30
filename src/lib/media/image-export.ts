import { encodeRgbaToTiff } from "./tiff-encoder";

export type ImageExportFormat = "png" | "webp" | "tiff";

export const IMAGE_FORMAT_LABELS: Record<ImageExportFormat, string> = {
  png: "PNG",
  webp: "WebP",
  tiff: "TIFF",
};

export const IMAGE_FORMAT_EXTENSIONS: Record<ImageExportFormat, string> = {
  png: "png",
  webp: "webp",
  tiff: "tiff",
};

let webpAlphaSupportCache: boolean | null = null;

/**
 * Feature-detects real WebP *encoding* support with alpha — not just
 * decoding/display support, which is much more widely available and not
 * what `canvas.toBlob` needs. `canvas.toBlob(cb, "image/webp")` never
 * rejects or throws when the type is unsupported — browsers that can't
 * encode WebP (older Safari) silently hand back a PNG blob instead — so the
 * only reliable check is round-tripping a real transparent pixel and
 * reading the resulting blob's own declared MIME type.
 */
export async function supportsWebpAlphaExport(): Promise<boolean> {
  if (webpAlphaSupportCache !== null) return webpAlphaSupportCache;
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    webpAlphaSupportCache = false;
    return false;
  }
  ctx.clearRect(0, 0, 1, 1);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp"));
  webpAlphaSupportCache = !!blob && blob.type === "image/webp";
  return webpAlphaSupportCache;
}

export interface EncodedImage {
  blob: Blob;
  format: ImageExportFormat;
  /** True when the requested format wasn't actually available in this browser and this silently fell back to PNG instead. */
  fellBack: boolean;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't encode the result image."));
    }, type);
  });
}

/**
 * Encodes a canvas to the requested format, never trusting a requested
 * format blindly — WebP support is verified (see supportsWebpAlphaExport)
 * and TIFF has no browser encoder at all, so it's always produced by
 * tiff-encoder.ts instead of canvas.toBlob. Falls back to PNG, which every
 * browser encodes with real alpha, rather than failing the export outright.
 */
export async function encodeCanvasForExport(canvas: HTMLCanvasElement, format: ImageExportFormat): Promise<EncodedImage> {
  if (format === "png") {
    return { blob: await canvasToBlob(canvas, "image/png"), format: "png", fellBack: false };
  }

  if (format === "webp") {
    if (await supportsWebpAlphaExport()) {
      const blob = await canvasToBlob(canvas, "image/webp");
      if (blob.type === "image/webp") return { blob, format: "webp", fellBack: false };
    }
    return { blob: await canvasToBlob(canvas, "image/png"), format: "png", fellBack: true };
  }

  // tiff
  const ctx = canvas.getContext("2d");
  if (!ctx) return { blob: await canvasToBlob(canvas, "image/png"), format: "png", fellBack: true };
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { blob: encodeRgbaToTiff(data, canvas.width, canvas.height), format: "tiff", fellBack: false };
}
