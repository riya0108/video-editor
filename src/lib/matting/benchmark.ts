import { removeBackgroundFromImage } from "./pipeline";

/**
 * PHASE 14 — PERFORMANCE OPTIMIZATION. Runs the REAL production matting
 * pipeline (src/lib/matting/pipeline/remove-background.ts) against
 * deterministic synthetic images at a spread of resolutions/frame-rates,
 * recording the metrics the phase asks for: inference time, total
 * processing time, peak memory, GPU memory, and throughput — broken out by
 * environment (CPU core count, available GPU) and by image/video
 * resolution and video fps.
 *
 * Deliberately NOT a synthetic micro-benchmark of an isolated model or
 * execution provider: it calls the exact same entry point
 * RemoveBackgroundTool.tsx calls, so the numbers reflect what a real user
 * actually experiences (model selection, refinement, decontamination,
 * compositing included), not just a best-case forward pass. Which model
 * and device (`modelUsed`/`provider` on each measurement) actually served
 * a case is reported rather than assumed — this repo's adapters don't
 * expose a "force this provider" test hook, and adding one would be new,
 * unverified surface area on inference-critical code for a benchmark's
 * sake, which is exactly the kind of premature complexity this phase's own
 * brief warns against. The router's real eligibility/ranking logic decides,
 * same as production.
 *
 * "Video" cases simulate this app's actual video AI-cutout architecture —
 * sparse per-frame sampling through the same image pipeline (see
 * src/lib/matting/pipeline/video-cutout.ts) — rather than requiring a real
 * video file/decode; ffmpeg's own encode/mux performance is a separate
 * concern already covered by Phase 13's export validation, not this
 * benchmark's job.
 */

export interface BenchmarkEnvironment {
  cpuCores: number;
  /** navigator.deviceMemory, in GB — Chrome/Edge only (an approximate, bucketed value by design in that API, not exact). Null where unsupported, never guessed. */
  deviceMemoryGb: number | null;
  webgpuAvailable: boolean;
  /** Best-effort GPU identification via WebGPU's adapter info — many browsers deliberately withhold or generalize this for fingerprinting-resistance reasons, so fields are commonly empty strings even when webgpuAvailable is true. */
  webgpuAdapterInfo: { vendor?: string; architecture?: string; description?: string } | null;
  userAgent: string;
}

export type BenchmarkCaseKind = "image" | "video";

export interface BenchmarkCase {
  id: string;
  kind: BenchmarkCaseKind;
  width: number;
  height: number;
  /** video cases only — the sample rate this case represents (this app samples video at a reduced fps for AI cutout, never every frame — see person-cutout.ts). */
  fps?: number;
  /** video cases only — how many synthetic frames to run through the pipeline for this case. */
  frameCount?: number;
}

export interface BenchmarkMeasurement {
  case: BenchmarkCase;
  ok: boolean;
  error?: string;
  modelUsed?: string;
  /** ms — model forward-pass time only (MattingResult.modelInferenceTimeMs), summed across frames for a video case. */
  inferenceTimeMs: number;
  /** ms — the whole pipeline call(s): model selection/load, inference, refinement, decontamination, quality analysis, compositing. Summed across frames for a video case. */
  totalTimeMs: number;
  /**
   * Delta of `performance.memory.usedJSHeapSize` across the run, in bytes —
   * Chrome/Edge only (non-standard API), null elsewhere. An honest
   * approximation, not a true continuously-sampled peak (no standard
   * browser API provides that either) — a large GC pause mid-run could
   * still show a smaller delta than the real peak.
   */
  peakMemoryBytes: number | null;
  /**
   * No standard browser API exposes GPU memory usage to page JS at all
   * (unlike `performance.memory` for JS heap) — always null. Kept as an
   * explicit field, not omitted, so a report reader sees plainly that GPU
   * memory could not be measured rather than assuming it was overlooked.
   */
  gpuMemoryBytes: null;
  /** Frames processed per second of wall-clock time. 1000/totalTimeMs for a single image case. */
  throughputFps: number;
}

export interface BenchmarkReport {
  environment: BenchmarkEnvironment;
  measurements: BenchmarkMeasurement[];
  generatedAt: string;
}

export const DEFAULT_IMAGE_CASES: BenchmarkCase[] = [
  { id: "image-480p", kind: "image", width: 854, height: 480 },
  { id: "image-720p", kind: "image", width: 1280, height: 720 },
  { id: "image-1080p", kind: "image", width: 1920, height: 1080 },
];

export const DEFAULT_VIDEO_CASES: BenchmarkCase[] = [
  { id: "video-480p-2fps", kind: "video", width: 854, height: 480, fps: 2, frameCount: 6 },
  { id: "video-720p-4fps", kind: "video", width: 1280, height: 720, fps: 4, frameCount: 6 },
  { id: "video-1080p-8fps", kind: "video", width: 1920, height: 1080, fps: 8, frameCount: 6 },
];

export const DEFAULT_BENCHMARK_CASES: BenchmarkCase[] = [...DEFAULT_IMAGE_CASES, ...DEFAULT_VIDEO_CASES];

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };
type GpuAdapterInfoLike = { vendor?: string; architecture?: string; description?: string };
type GpuAdapterLike = { info?: GpuAdapterInfoLike };
type GpuLike = { requestAdapter: () => Promise<GpuAdapterLike | null> };

export async function detectBenchmarkEnvironment(): Promise<BenchmarkEnvironment> {
  const nav = typeof navigator !== "undefined" ? (navigator as NavigatorWithDeviceMemory) : undefined;
  const cpuCores = nav?.hardwareConcurrency || 4;
  const deviceMemoryGb = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;

  let webgpuAvailable = false;
  let webgpuAdapterInfo: BenchmarkEnvironment["webgpuAdapterInfo"] = null;
  const gpu = (nav as (Navigator & { gpu?: GpuLike }) | undefined)?.gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        webgpuAvailable = true;
        // `adapter.info` is the current spec property for adapter
        // identification; the older `requestAdapterInfo()` method has been
        // removed from the spec (and this app's TS lib types) entirely, so
        // there's no fallback to try — just an honest null when a browser
        // doesn't populate `info`.
        const info = adapter.info;
        if (info) {
          webgpuAdapterInfo = {
            vendor: info.vendor || undefined,
            architecture: info.architecture || undefined,
            description: info.description || undefined,
          };
        }
      }
    } catch {
      webgpuAvailable = false;
    }
  }

  return {
    cpuCores,
    deviceMemoryGb,
    webgpuAvailable,
    webgpuAdapterInfo,
    userAgent: nav?.userAgent ?? "unknown",
  };
}

/**
 * Deterministic synthetic test image — gradient backdrop + a solid
 * subject-shaped blob — so every benchmark run exercises the same input
 * regardless of environment, without requiring a real upload. Not
 * photorealistic; that's not the point — it just needs to be a plausible,
 * reproducible foreground/background split for the pipeline to run its
 * real work against.
 */
export function generateSyntheticTestImage(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#1e293b");
  grad.addColorStop(1, "#0f766e");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#f5d0a9";
  ctx.beginPath();
  ctx.ellipse(width / 2, height / 2, width * 0.28, height * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

function memorySnapshotBytes(): number | null {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize : null;
}

async function runImageCase(testCase: BenchmarkCase): Promise<BenchmarkMeasurement> {
  const canvas = generateSyntheticTestImage(testCase.width, testCase.height);
  const before = memorySnapshotBytes();
  const start = performance.now();
  try {
    const result = await removeBackgroundFromImage(canvas, testCase.width, testCase.height);
    const totalTimeMs = performance.now() - start;
    const after = memorySnapshotBytes();
    return {
      case: testCase,
      ok: true,
      modelUsed: result.modelUsed,
      inferenceTimeMs: result.modelInferenceTimeMs,
      totalTimeMs,
      peakMemoryBytes: before !== null && after !== null ? Math.max(0, after - before) : null,
      gpuMemoryBytes: null,
      throughputFps: totalTimeMs > 0 ? 1000 / totalTimeMs : 0,
    };
  } catch (err) {
    return {
      case: testCase,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      inferenceTimeMs: 0,
      totalTimeMs: performance.now() - start,
      peakMemoryBytes: null,
      gpuMemoryBytes: null,
      throughputFps: 0,
    };
  }
}

/** Runs `frameCount` synthetic frames through the same per-frame matting call the video AI-cutout path uses (see video-cutout.ts), reusing one shared source canvas — matching production, which reuses one working canvas across sampled frames too. */
async function runVideoCase(testCase: BenchmarkCase): Promise<BenchmarkMeasurement> {
  const frameCount = testCase.frameCount ?? 6;
  const canvas = generateSyntheticTestImage(testCase.width, testCase.height);
  const before = memorySnapshotBytes();
  const start = performance.now();
  let inferenceTimeMs = 0;
  let modelUsed: string | undefined;
  let processed = 0;
  try {
    for (let i = 0; i < frameCount; i++) {
      const result = await removeBackgroundFromImage(canvas, testCase.width, testCase.height);
      inferenceTimeMs += result.modelInferenceTimeMs;
      modelUsed = result.modelUsed;
      processed++;
    }
    const totalTimeMs = performance.now() - start;
    const after = memorySnapshotBytes();
    return {
      case: testCase,
      ok: true,
      modelUsed,
      inferenceTimeMs,
      totalTimeMs,
      peakMemoryBytes: before !== null && after !== null ? Math.max(0, after - before) : null,
      gpuMemoryBytes: null,
      throughputFps: totalTimeMs > 0 ? (processed / totalTimeMs) * 1000 : 0,
    };
  } catch (err) {
    // A partial run (some frames processed before a failure) still reports
    // what it measured rather than discarding it — `ok` reflects whether
    // ANY frame succeeded, matching production's own "one bad frame
    // shouldn't fail the whole clip" behavior (video-cutout.ts).
    return {
      case: testCase,
      ok: processed > 0,
      error: err instanceof Error ? err.message : String(err),
      modelUsed,
      inferenceTimeMs,
      totalTimeMs: performance.now() - start,
      peakMemoryBytes: null,
      gpuMemoryBytes: null,
      throughputFps: 0,
    };
  }
}

export async function runBenchmarkSuite(
  cases: BenchmarkCase[] = DEFAULT_BENCHMARK_CASES,
  onProgress?: (completed: number, total: number, current: BenchmarkCase) => void,
): Promise<BenchmarkReport> {
  const environment = await detectBenchmarkEnvironment();
  const measurements: BenchmarkMeasurement[] = [];
  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    onProgress?.(i, cases.length, testCase);
    measurements.push(testCase.kind === "image" ? await runImageCase(testCase) : await runVideoCase(testCase));
  }
  if (cases.length > 0) onProgress?.(cases.length, cases.length, cases[cases.length - 1]);
  return { environment, measurements, generatedAt: new Date().toISOString() };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Renders a report as a Markdown table — pure/DOM-free so it's unit-testable and so the benchmark UI can offer a plain "copy results" action. */
export function formatReportAsMarkdown(report: BenchmarkReport): string {
  const env = report.environment;
  const lines: string[] = [];
  lines.push(`# Matting performance benchmark — ${report.generatedAt}`);
  lines.push("");
  lines.push("## Environment");
  lines.push(`- CPU cores: ${env.cpuCores}`);
  lines.push(`- Device memory: ${env.deviceMemoryGb !== null ? `${env.deviceMemoryGb}GB (approximate)` : "unknown"}`);
  lines.push(`- WebGPU available: ${env.webgpuAvailable ? "yes" : "no"}`);
  if (env.webgpuAdapterInfo) {
    const { vendor, architecture, description } = env.webgpuAdapterInfo;
    lines.push(`- GPU: ${[vendor, architecture, description].filter(Boolean).join(" / ") || "(browser withheld details)"}`);
  }
  lines.push(`- User agent: ${env.userAgent}`);
  lines.push("");
  lines.push("## Measurements");
  lines.push("");
  lines.push("| Case | Kind | Resolution | Model | Inference | Total | Peak memory | GPU memory | Throughput |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const m of report.measurements) {
    const resolution = `${m.case.width}×${m.case.height}${m.case.fps ? ` @${m.case.fps}fps` : ""}`;
    if (!m.ok) {
      lines.push(`| ${m.case.id} | ${m.case.kind} | ${resolution} | — | — | — | — | — | FAILED: ${m.error ?? "unknown error"} |`);
      continue;
    }
    lines.push(
      `| ${m.case.id} | ${m.case.kind} | ${resolution} | ${m.modelUsed ?? "unknown"} | ${formatMs(m.inferenceTimeMs)} | ${formatMs(m.totalTimeMs)} | ${formatBytes(m.peakMemoryBytes)} | n/a (no browser API) | ${m.throughputFps.toFixed(2)} fps |`,
    );
  }
  return lines.join("\n");
}
