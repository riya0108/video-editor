import * as ort from "onnxruntime-web";
import { createInferenceSession } from "../ml/onnx-runtime";
import { downloadModelFileFromUrl } from "../ml/model-cache";

// Real-ESRGAN's "general x4v3" weights (SRVGGNetCompact: 32 conv layers vs.
// x4plus's ~23 residual-in-residual dense blocks) — roughly an order of
// magnitude less compute per pixel than the RRDBNet x4plus model this used
// to point at, which is why upstream ships it as the recommended variant for
// video specifically. Self-hosted (rather than fetched from a third-party HF
// repo, like this app's other ML models) for two reasons: it's small enough
// (~5MB) to be no real cost, and the upstream ONNX export's trailing Clip
// node crashes onnxruntime-web's WebGPU (JSEP) backend on this build with a
// "Failed to run JSEP kernel" error — the model here has that node stripped
// (output is unclamped, which is fine: the app already clamps when writing
// pixels back out via Uint8ClampedArray) after verifying the rest of the
// graph and its output against the original.
const MODEL_URL = "/models/realesr-general-x4v3.onnx";

// Stripping the Clip node above only moved the same WebGPU (JSEP) crash to
// the node before it (an Add combining a pixel-shuffle upsample with a
// bilinear-resized skip connection) — reproducible at multiple tile sizes,
// so it's this model's op graph tripping a backend bug, not that one node.
// Retrying on WASM after a failed WebGPU run was tried and is itself flaky
// (onnxruntime-web's WASM proxy worker isn't reliably ready yet when spun up
// reactively mid-session). WASM alone measured ~10-20x faster than the old
// RRDBNet model anyway, so just skip WebGPU for this model entirely rather
// than ship a path that reproducibly crashes for anyone whose browser
// exposes a WebGPU adapter.
const DEVICE = { provider: "wasm", useFp16: false } as const;

/** Fixed scale factor of the bundled Real-ESRGAN weights — every inference call quadruples width and height. */
export const SR_SCALE = 4;

// Matches the tile/overlap size the model's own reference implementation
// uses (see SceneWorks/real-esrgan-onnx's README): big enough that overlap
// stitching overhead stays small, small enough to bound peak memory/compute
// for a single inference call on CPU wasm.
const TILE = 256;
const OVERLAP = 16;

export interface UpscaleProgress {
  phase: "downloading" | "upscaling";
  fraction: number;
}

let cachedSession: Promise<ort.InferenceSession> | null = null;

function loadSession(onProgress?: (p: UpscaleProgress) => void): Promise<ort.InferenceSession> {
  if (cachedSession) return cachedSession;
  const promise = (async () => {
    const bytes = await downloadModelFileFromUrl(MODEL_URL, (f) => onProgress?.({ phase: "downloading", fraction: f }));
    return createInferenceSession(bytes, DEVICE);
  })();
  promise.catch(() => {
    if (cachedSession === promise) cachedSession = null;
  });
  cachedSession = promise;
  return promise;
}

/** Pre-warms and caches the SR model so a later upscale call doesn't pay the download cost mid-progress-bar. */
export function preloadSuperResolutionModel(onProgress?: (p: UpscaleProgress) => void): Promise<void> {
  return loadSession(onProgress).then(() => undefined);
}

function imageDataToTensor(data: Uint8ClampedArray, w: number, h: number): ort.Tensor {
  const plane = w * h;
  const floatData = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    floatData[p] = data[o] / 255;
    floatData[plane + p] = data[o + 1] / 255;
    floatData[2 * plane + p] = data[o + 2] / 255;
  }
  return new ort.Tensor("float32", floatData, [1, 3, h, w]);
}

function tensorToImageData(tensor: ort.Tensor): ImageData {
  const dims = tensor.dims as number[];
  const h = dims[2];
  const w = dims[3];
  const src = tensor.data as Float32Array;
  const plane = w * h;
  const out = new Uint8ClampedArray(plane * 4);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    out[o] = src[p] * 255;
    out[o + 1] = src[plane + p] * 255;
    out[o + 2] = src[2 * plane + p] * 255;
    out[o + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Builds a `w+2*pad` x `h+2*pad` canvas holding `source` in the center with
 * its edge pixels replicated into the border — so tiles cut near an image
 * edge still get real (if repeated) context on all sides instead of a hard
 * transparent/black edge, which would otherwise show up as a seam or a dark
 * fringe once the model's receptive field crosses it.
 */
function buildPaddedCanvas(source: CanvasImageSource, w: number, h: number, pad: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w + 2 * pad;
  canvas.height = h + 2 * pad;
  const ctx = canvas.getContext("2d")!;

  ctx.drawImage(source, 0, 0, w, h, pad, pad, w, h);
  if (pad > 0) {
    ctx.drawImage(source, 0, 0, w, 1, pad, 0, w, pad); // top
    ctx.drawImage(source, 0, h - 1, w, 1, pad, h + pad, w, pad); // bottom
    ctx.drawImage(source, 0, 0, 1, h, 0, pad, pad, h); // left
    ctx.drawImage(source, w - 1, 0, 1, h, w + pad, pad, pad, h); // right
    ctx.drawImage(source, 0, 0, 1, 1, 0, 0, pad, pad); // top-left
    ctx.drawImage(source, w - 1, 0, 1, 1, w + pad, 0, pad, pad); // top-right
    ctx.drawImage(source, 0, h - 1, 1, 1, 0, h + pad, pad, pad); // bottom-left
    ctx.drawImage(source, w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad); // bottom-right
  }
  return canvas;
}

/**
 * Runs real (neural-network) 4x super-resolution on a single image, tiled so
 * peak memory/compute per inference call stays bounded regardless of source
 * size. Unlike lanczos+unsharp resizing, the model was trained to hallucinate
 * plausible high-frequency detail, so it can produce genuinely sharper output
 * rather than just a smoothly-interpolated, contrast-boosted enlargement.
 *
 * Tried batching multiple same-size tiles into one inference call here (to
 * amortize the WASM proxy worker's per-call marshaling cost) — measured
 * directly in-browser (16 tiles, batches of 4 vs. one at a time, same image)
 * and it was *not* faster (23s batched vs. 19s unbatched): this model is
 * compute-bound, not per-call-overhead-bound, so grouping tiles doesn't
 * reduce work, and larger tensors cost about as much extra to marshal as
 * batching saves. Reverted rather than keep the added complexity for no
 * measured benefit — don't re-attempt without new evidence it actually helps.
 */
export async function upscaleImageSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  onProgress?: (p: UpscaleProgress) => void,
): Promise<HTMLCanvasElement> {
  const session = await loadSession(onProgress);
  const padded = buildPaddedCanvas(source, width, height, OVERLAP);

  const result = document.createElement("canvas");
  result.width = width * SR_SCALE;
  result.height = height * SR_SCALE;
  const resultCtx = result.getContext("2d")!;

  const tilesX = Math.ceil(width / TILE);
  const tilesY = Math.ceil(height / TILE);
  const totalTiles = tilesX * tilesY;
  let done = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const tw = Math.min(TILE, width - x0);
      const th = Math.min(TILE, height - y0);
      const paddedW = tw + 2 * OVERLAP;
      const paddedH = th + 2 * OVERLAP;

      const tileCanvas = document.createElement("canvas");
      tileCanvas.width = paddedW;
      tileCanvas.height = paddedH;
      const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true })!;
      tileCtx.drawImage(padded, x0, y0, paddedW, paddedH, 0, 0, paddedW, paddedH);

      const { data } = tileCtx.getImageData(0, 0, paddedW, paddedH);
      const inputTensor = imageDataToTensor(data, paddedW, paddedH);
      const outputs = await session.run({ [session.inputNames[0]]: inputTensor });
      const outTensor = outputs[session.outputNames[0]];
      const outImageData = tensorToImageData(outTensor);

      const outCanvas = document.createElement("canvas");
      outCanvas.width = outImageData.width;
      outCanvas.height = outImageData.height;
      outCanvas.getContext("2d")!.putImageData(outImageData, 0, 0);

      resultCtx.drawImage(
        outCanvas,
        OVERLAP * SR_SCALE,
        OVERLAP * SR_SCALE,
        tw * SR_SCALE,
        th * SR_SCALE,
        x0 * SR_SCALE,
        y0 * SR_SCALE,
        tw * SR_SCALE,
        th * SR_SCALE,
      );

      done++;
      onProgress?.({ phase: "upscaling", fraction: done / totalTiles });
    }
  }

  return result;
}
