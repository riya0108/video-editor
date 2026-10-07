import type { AIFrame } from "./media";
import type { DetectorBackend, RawDetection } from "./features/detection";
import type { ModelInfo } from "./types";

/**
 * MediaPipe Tasks (Vision) backends for face and object detection — BROWSER ONLY. Same loading convention as the
 * app's selfie segmenter (lib/media/selfie-segmenter.ts): the WASM runtime from jsdelivr, the model weights
 * self-hosted under /public/models (see public/models/LICENSES/MEDIAPIPE_DETECTORS_NOTICE.txt). Faces: GPU delegate
 * when available, CPU fallback. Objects: CPU only (the int8 model silently returns nothing on GPU). Models load once
 * and are reused.
 */

const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

export const FACE_MODEL: ModelInfo = { name: "MediaPipe BlazeFace (short range)", source: "/models/blaze_face_short_range.tflite", license: "Apache-2.0", sizeBytes: 229746 };
export const OBJECT_MODEL: ModelInfo = { name: "EfficientDet-Lite0 int8 (COCO, 80 classes)", source: "/models/efficientdet_lite0.tflite", license: "Apache-2.0", sizeBytes: 4602795 };

let facePromise: Promise<DetectorBackend> | null = null;
let objectPromise: Promise<DetectorBackend> | null = null;

function toCanvas(frame: AIFrame): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return c;
}

async function withDelegate<T>(make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try {
    return await make("GPU");
  } catch {
    return make("CPU");
  }
}

export function loadFaceDetector(): Promise<DetectorBackend> {
  facePromise ??= (async () => {
    const { FilesetResolver, FaceDetector } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    const detector = await withDelegate((delegate) => FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL.source, delegate }, runningMode: "IMAGE", minDetectionConfidence: 0.3 }));
    return {
      async detect(frame: AIFrame): Promise<RawDetection[]> {
        const res = detector.detect(toCanvas(frame));
        return res.detections.map((d) => {
          const b = d.boundingBox!;
          return {
            box: { x: b.originX / frame.width, y: b.originY / frame.height, w: b.width / frame.width, h: b.height / frame.height },
            label: "face",
            score: d.categories[0]?.score ?? 0,
            keypoints: d.keypoints?.map((k) => ({ x: k.x, y: k.y })),
          };
        });
      },
    };
  })().catch((e) => {
    facePromise = null; // allow a retry after a network failure
    throw e;
  });
  return facePromise;
}

export function loadObjectDetector(): Promise<DetectorBackend> {
  objectPromise ??= (async () => {
    const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    // CPU delegate on purpose: with the GPU delegate this int8-quantized model loads fine but returns NO detections
    // (no error at all) — found in live testing (AI_EDITING_TEST_REPORT.md). The CPU/XNNPACK path is correct.
    const detector = await ObjectDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: OBJECT_MODEL.source, delegate: "CPU" }, runningMode: "IMAGE", scoreThreshold: 0.3, maxResults: 20 });
    return {
      async detect(frame: AIFrame): Promise<RawDetection[]> {
        const res = detector.detect(toCanvas(frame));
        return res.detections.map((d) => {
          const b = d.boundingBox!;
          return { box: { x: b.originX / frame.width, y: b.originY / frame.height, w: b.width / frame.width, h: b.height / frame.height }, label: d.categories[0]?.categoryName ?? "object", score: d.categories[0]?.score ?? 0 };
        });
      },
    };
  })().catch((e) => {
    objectPromise = null;
    throw e;
  });
  return objectPromise;
}

/** MediaPipe needs a DOM canvas + WebAssembly. */
export function mediapipeAvailable(): { available: true } | { available: false; reason: string } {
  if (typeof document === "undefined" || typeof WebAssembly === "undefined") return { available: false, reason: "Needs a browser with WebAssembly." };
  return { available: true };
}
