import type { CutoutProgress } from "../captions/person-cutout";
import {
  keyChromaForeground,
  drawBgReplacement,
  drawBlurredBackdrop,
  type BgReplaceSettings,
  type ChromaSettings,
} from "./bg-removal-canvas";
import { removeBackgroundFromImage as runMattingPipeline } from "../matting/pipeline";
import { encodeCanvasForExport, type ImageExportFormat } from "./image-export";

export interface ImageBgRemovalMattingInfo {
  confidence: number;
  warnings: string[];
  modelUsed: string;
}

export interface ImageBgRemovalResult {
  /** Final image composited onto the chosen replacement background. */
  blob: Blob;
  /** Whichever format `blob` actually ended up in — may differ from the requested `format` if the browser couldn't honor it (see encodeCanvasForExport). */
  format: ImageExportFormat;
  formatFellBack: boolean;
  /** Just the cut-out subject on a transparent background, regardless of `replace` — handy as a secondary download. */
  cutoutBlob: Blob;
  width: number;
  height: number;
  /** Present only for AI mode — chroma mode doesn't run a model, so there's nothing to report here. See src/lib/matting/pipeline. */
  matting?: ImageBgRemovalMattingInfo;
}

function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode that image."));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't encode the result image."));
    }, "image/png");
  });
}

/** Roughly matches the blur radius the video preview/export use, scaled to the image's own size instead of a fixed preview stage. */
function blurPxFor(width: number, height: number): number {
  return Math.max(4, Math.round(Math.max(width, height) * 0.035));
}

/**
 * Removes the background from a still image, either by chroma-keying a known
 * backdrop color or by running the in-browser AI matting pipeline
 * (src/lib/matting/pipeline — model-selection + alpha refinement + edge
 * refinement + colour decontamination + quality analysis, see
 * MATTE_IMPLEMENTATION_PLAN.md), then composites the cutout onto the chosen
 * replacement. AI mode no longer calls RMBG-1.4 directly: the pipeline's
 * router picks U²-Net (Apache-2.0, self-hosted — see MODEL_LICENSES.md) or
 * the MediaPipe selfie segmenter by default, and only reaches RMBG-1.4 if
 * explicitly opted into (not done here), since RMBG-1.4 is non-commercial-
 * licensed.
 */
export async function removeBackgroundFromImage(
  file: File,
  opts: {
    mode: "chroma" | "ai";
    chroma?: ChromaSettings;
    replace: BgReplaceSettings;
    /** Only meaningful when `replace.mode === "transparent"` — every other mode is fully opaque, so PNG vs. WebP vs. TIFF makes no visual difference and PNG is used regardless. */
    format?: ImageExportFormat;
  },
  onProgress?: (p: CutoutProgress) => void,
): Promise<ImageBgRemovalResult> {
  const objectUrl = URL.createObjectURL(file);
  const img = await loadImageFromSrc(objectUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  let foreground: CanvasImageSource;
  let cutoutBlob: Blob;
  let matting: ImageBgRemovalMattingInfo | undefined;

  try {
    if (opts.mode === "chroma") {
      if (!opts.chroma) throw new Error("Missing chroma settings.");
      const work = document.createElement("canvas");
      const keyed = keyChromaForeground(img, w, h, opts.chroma, work);
      cutoutBlob = await canvasToBlob(keyed);
      foreground = keyed;
    } else {
      const result = await runMattingPipeline(img, w, h, {
        onModelLoadProgress: (fraction) => onProgress?.({ phase: "downloading", fraction }),
      });
      onProgress?.({ phase: "processing", fraction: 1 });
      cutoutBlob = await canvasToBlob(result.foreground);
      foreground = result.foreground;
      matting = { confidence: result.confidence, warnings: result.warnings, modelUsed: result.modelUsed };
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = w;
    outCanvas.height = h;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) throw new Error("Canvas isn't supported in this browser.");
    const stage = { width: w, height: h };

    ctx.clearRect(0, 0, w, h);
    if (opts.replace.mode === "blur") {
      drawBlurredBackdrop(ctx, img, w, h, stage, blurPxFor(w, h));
    } else {
      drawBgReplacement(ctx, stage, opts.replace);
    }
    ctx.drawImage(foreground, 0, 0, w, h);

    const requestedFormat: ImageExportFormat = opts.replace.mode === "transparent" ? (opts.format ?? "png") : "png";
    const encoded = await encodeCanvasForExport(outCanvas, requestedFormat);
    return { blob: encoded.blob, format: encoded.format, formatFellBack: encoded.fellBack, cutoutBlob, width: w, height: h, matting };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
