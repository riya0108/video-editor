import { loadSegmenter, type CutoutProgress } from "../captions/person-cutout";
import {
  keyChromaForeground,
  drawBgReplacement,
  drawBlurredBackdrop,
  type BgReplaceSettings,
  type ChromaSettings,
} from "./bg-removal-canvas";

export interface ImageBgRemovalResult {
  /** Final image composited onto the chosen replacement background. */
  blob: Blob;
  /** Just the cut-out subject on a transparent background, regardless of `replace` — handy as a secondary download. */
  cutoutBlob: Blob;
  width: number;
  height: number;
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
 * backdrop color or by running an in-browser AI subject-segmentation model
 * (RMBG-1.4 — the same one already used for "behind a person" captions), then
 * composites the cutout onto the chosen replacement.
 */
export async function removeBackgroundFromImage(
  file: File,
  opts: {
    mode: "chroma" | "ai";
    chroma?: ChromaSettings;
    replace: BgReplaceSettings;
  },
  onProgress?: (p: CutoutProgress) => void,
): Promise<ImageBgRemovalResult> {
  const objectUrl = URL.createObjectURL(file);
  const img = await loadImageFromSrc(objectUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  let foreground: CanvasImageSource;
  let cutoutBlob: Blob;
  let cutoutObjectUrl: string | null = null;

  try {
    if (opts.mode === "chroma") {
      if (!opts.chroma) throw new Error("Missing chroma settings.");
      const work = document.createElement("canvas");
      const keyed = keyChromaForeground(img, w, h, opts.chroma, work);
      cutoutBlob = await canvasToBlob(keyed);
      foreground = keyed;
    } else {
      const [segmenter, { RawImage }] = await Promise.all([
        loadSegmenter(onProgress),
        import("@huggingface/transformers"),
      ]);
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = w;
      srcCanvas.height = h;
      const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
      if (!srcCtx) throw new Error("Canvas isn't supported in this browser.");
      srcCtx.drawImage(img, 0, 0, w, h);

      const output = await segmenter(srcCanvas);
      let mask = output[0]?.mask;
      if (!mask) throw new Error("NO_SUBJECT");
      if (mask.width !== w || mask.height !== h) mask = await mask.resize(w, h);
      mask.grayscale();

      const cutoutRaw = RawImage.fromCanvas(srcCanvas).clone().rgba();
      cutoutRaw.putAlpha(mask);
      cutoutBlob = (await cutoutRaw.toBlob("image/png")) as Blob;
      cutoutObjectUrl = URL.createObjectURL(cutoutBlob);
      foreground = await loadImageFromSrc(cutoutObjectUrl);
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

    const blob = await canvasToBlob(outCanvas);
    return { blob, cutoutBlob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(objectUrl);
    if (cutoutObjectUrl) URL.revokeObjectURL(cutoutObjectUrl);
  }
}
