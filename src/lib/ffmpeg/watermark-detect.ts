import type { FractionRect } from "../../components/tool/video/RectOverlay";

export interface WatermarkDetection {
  /** 1 region for a quick scan, up to a few for the thorough scan. Empty if nothing static/logo-shaped was found. */
  regions: FractionRect[];
  /** Set instead of multiple `regions` when the found boxes form a regular grid — feeds directly into the existing tile-pattern feature. */
  tileHint?: { rows: number; cols: number };
}

interface DetectOptions {
  /** Slower, more thorough scan: more sampled frames, a finer grid, and support for multiple/repeating watermarks. */
  thorough?: boolean;
  onProgress?: (fraction: number) => void;
}

const QUICK = { frames: 8, analysisWidth: 240, gridCols: 24, maxBoxes: 1 };
const THOROUGH = { frames: 20, analysisWidth: 360, gridCols: 40, maxBoxes: 4 };

// A watermark/logo overlay is (a) pixel-static across time while real footage
// around it changes, and (b) has above-average local edge/contrast density
// (it's a graphic or text, not blank space). Below this combined-score floor
// there's nothing confidently static+detailed enough to call a watermark.
const STATIC_FLOOR = 0.6;
const DENSITY_FLOOR = 0.5;
const MAX_AREA_FRACTION = 0.3;
/** Iterative "Smart pro" boxes must still be at least this fraction as strong as the best one to count. */
const RELATIVE_DENSITY_FLOOR = 0.6;
/**
 * A real logo/watermark spans several grid cells. Without a floor, the brute-force
 * window search below always collapses to whichever single cell has the highest score,
 * since adding any lower-scoring neighbor can only pull the window's average down —
 * that single cell is almost never the watermark, just noise (a compression artifact,
 * a stray highlight). Requiring at least a 2x2 footprint forces the search to prefer a
 * cluster of consistently-scoring cells over one lucky outlier.
 */
const MIN_WINDOW_CELLS = 2;

function waitForSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
  });
}

interface SampleGrid {
  cols: number;
  rows: number;
  /** Per-sample, per-cell mean luminance (0-255). */
  meanLum: Float64Array[];
  /** Per-sample, per-cell mean gradient magnitude — a cheap edge-density proxy. */
  edgeDensity: Float64Array[];
}

async function sampleGrid(
  video: HTMLVideoElement,
  frameCount: number,
  analysisWidth: number,
  gridCols: number,
  onProgress?: (fraction: number) => void,
): Promise<SampleGrid> {
  const naturalW = video.videoWidth;
  const naturalH = video.videoHeight;
  const scale = Math.min(1, analysisWidth / naturalW);
  const w = Math.max(2, Math.round((naturalW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((naturalH * scale) / 2) * 2);
  const gridRows = Math.max(1, Math.round(gridCols * (h / w)));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { cols: gridCols, rows: gridRows, meanLum: [], edgeDensity: [] };

  const duration = video.duration || 0;
  const t0 = duration * 0.03;
  const t1 = duration * 0.97;
  const times: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    times.push(frameCount > 1 ? t0 + ((t1 - t0) * i) / (frameCount - 1) : (t0 + t1) / 2);
  }

  const cellW = w / gridCols;
  const cellH = h / gridRows;
  const meanLum: Float64Array[] = [];
  const edgeDensity: Float64Array[] = [];

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();

  try {
    for (let i = 0; i < times.length; i++) {
      video.currentTime = times[i];
      await waitForSeek(video);
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);

      const lum = new Float32Array(w * h);
      for (let p = 0; p < w * h; p++) {
        const o = p * 4;
        lum[p] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      }

      const lumSum = new Float64Array(gridCols * gridRows);
      const edgeSum = new Float64Array(gridCols * gridRows);
      const count = new Float64Array(gridCols * gridRows);

      for (let y = 0; y < h; y++) {
        const row = Math.min(gridRows - 1, Math.floor(y / cellH));
        for (let x = 0; x < w; x++) {
          const col = Math.min(gridCols - 1, Math.floor(x / cellW));
          const cell = row * gridCols + col;
          const p = y * w + x;
          lumSum[cell] += lum[p];
          count[cell] += 1;
          if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
            const gx = lum[p + 1] - lum[p - 1];
            const gy = lum[p + w] - lum[p - w];
            edgeSum[cell] += Math.abs(gx) + Math.abs(gy);
          }
        }
      }

      const lumCell = new Float64Array(gridCols * gridRows);
      const edgeCell = new Float64Array(gridCols * gridRows);
      for (let cell = 0; cell < lumCell.length; cell++) {
        lumCell[cell] = count[cell] > 0 ? lumSum[cell] / count[cell] : 0;
        edgeCell[cell] = count[cell] > 0 ? edgeSum[cell] / count[cell] : 0;
      }
      meanLum.push(lumCell);
      edgeDensity.push(edgeCell);

      onProgress?.((i + 1) / times.length);
    }
  } finally {
    video.currentTime = originalTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  return { cols: gridCols, rows: gridRows, meanLum, edgeDensity };
}

function variance(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
}

function minMaxNormalize(values: Float64Array): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = range > 1e-6 ? (values[i] - min) / range : 0;
  return out;
}

/**
 * Scores each grid cell: static (low temporal luminance variance) + detailed (high edge
 * density) + edge-consistent (the edge signal itself recurs at a steady level from frame
 * to frame) + near a corner.
 *
 * The edge-consistency term matters for watermarks sitting over moving footage (hands,
 * traffic, anything crossing behind a semi-transparent logo): the cell's raw luminance
 * variance is high there because the background keeps changing, which tanks staticScore
 * even though the watermark itself never moves. But the watermark keeps contributing a
 * steady edge floor every frame, while a passing object's edges appear only while it's
 * actually in that cell — so edge density has a low coefficient of variation for a
 * watermark and a high one for transient motion. This rescues watermark cells that
 * staticScore alone would otherwise bury under any part of the frame that's truly static
 * (unmoving background detail), which typically wins on staticScore alone.
 */
function scoreGrid(grid: SampleGrid): { score: Float64Array; staticScore: Float64Array } {
  const { cols, rows, meanLum, edgeDensity } = grid;
  const cellCount = cols * rows;
  const temporalVar = new Float64Array(cellCount);
  const edgeAvg = new Float64Array(cellCount);
  const edgeConsistency = new Float64Array(cellCount);
  const sampleCount = meanLum.length;

  for (let cell = 0; cell < cellCount; cell++) {
    const lums: number[] = [];
    const edges: number[] = [];
    for (let s = 0; s < sampleCount; s++) {
      lums.push(meanLum[s][cell]);
      edges.push(edgeDensity[s][cell]);
    }
    temporalVar[cell] = variance(lums);
    const edgeMean = sampleCount > 0 ? edges.reduce((a, b) => a + b, 0) / sampleCount : 0;
    const edgeStd = Math.sqrt(variance(edges));
    edgeAvg[cell] = edgeMean;
    // +5 damps the ratio for near-blank cells so they don't register as "consistent" by default.
    edgeConsistency[cell] = edgeMean / (edgeStd + 5);
  }

  const normVar = minMaxNormalize(temporalVar);
  const edgeScore = minMaxNormalize(edgeAvg);
  const edgeConsistencyScore = minMaxNormalize(edgeConsistency);
  const staticScore = new Float64Array(cellCount);
  const score = new Float64Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) {
    staticScore[cell] = 1 - normVar[cell];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    const cx = (col + 0.5) / cols;
    const cy = (row + 0.5) / rows;
    const corners = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    let dist = Infinity;
    for (const [cornerX, cornerY] of corners) {
      dist = Math.min(dist, Math.hypot(cx - cornerX, cy - cornerY));
    }
    const cornerProx = Math.max(0, Math.min(1, 1 - dist / 0.75));
    score[cell] =
      0.3 * staticScore[cell] + 0.3 * edgeScore[cell] + 0.3 * edgeConsistencyScore[cell] + 0.1 * cornerProx;
  }

  return { score, staticScore };
}

interface GridWindow {
  top: number;
  left: number;
  h: number;
  w: number;
  density: number;
}

function integralImage(score: Float64Array, cols: number, rows: number): Float64Array {
  const integral = new Float64Array((cols + 1) * (rows + 1));
  for (let y = 0; y < rows; y++) {
    let rowSum = 0;
    for (let x = 0; x < cols; x++) {
      rowSum += score[y * cols + x];
      integral[(y + 1) * (cols + 1) + (x + 1)] = integral[y * (cols + 1) + (x + 1)] + rowSum;
    }
  }
  return integral;
}

function windowSum(integral: Float64Array, cols: number, top: number, left: number, h: number, w: number): number {
  const stride = cols + 1;
  return (
    integral[(top + h) * stride + (left + w)] -
    integral[top * stride + (left + w)] -
    integral[(top + h) * stride + left] +
    integral[top * stride + left]
  );
}

function bestWindow(score: Float64Array, cols: number, rows: number): GridWindow | null {
  const integral = integralImage(score, cols, rows);
  const maxArea = Math.max(1, Math.floor(cols * rows * MAX_AREA_FRACTION));
  const minH = Math.max(1, Math.min(MIN_WINDOW_CELLS, rows));
  const minW = Math.max(1, Math.min(MIN_WINDOW_CELLS, cols));
  let best: GridWindow | null = null;
  for (let top = 0; top < rows; top++) {
    for (let h = minH; top + h <= rows; h++) {
      for (let left = 0; left < cols; left++) {
        for (let w = minW; left + w <= cols && h * w <= maxArea; w++) {
          const sum = windowSum(integral, cols, top, left, h, w);
          const density = sum / (h * w);
          if (!best || density > best.density) best = { top, left, h, w, density };
        }
      }
    }
  }
  return best;
}

function windowToRect(win: GridWindow, cols: number, rows: number): FractionRect {
  return { x: win.left / cols, y: win.top / rows, w: win.w / cols, h: win.h / rows };
}

/** Clusters values that are within `tolerance` of each other, returning one representative per cluster. */
function clusterValues(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[last.length - 1] <= tolerance) last.push(v);
    else clusters.push([v]);
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

function detectTileHint(boxes: FractionRect[]): { rows: number; cols: number } | null {
  if (boxes.length < 2) return null;
  const centersX = boxes.map((b) => b.x + b.w / 2);
  const centersY = boxes.map((b) => b.y + b.h / 2);
  const uniqueX = clusterValues(centersX, 0.05);
  const uniqueY = clusterValues(centersY, 0.05);
  if (uniqueX.length * uniqueY.length !== boxes.length) return null;
  const avgW = boxes.reduce((s, b) => s + b.w, 0) / boxes.length;
  const avgH = boxes.reduce((s, b) => s + b.h, 0) / boxes.length;
  const sizesMatch = boxes.every((b) => Math.abs(b.w - avgW) / avgW < 0.1 && Math.abs(b.h - avgH) / avgH < 0.1);
  if (!sizesMatch) return null;
  return { rows: uniqueY.length, cols: uniqueX.length };
}

/**
 * Scans sampled frames for a region that's pixel-static over time and has
 * above-average edge/contrast density — the fingerprint of a static
 * watermark or logo overlay, as opposed to a moving scene or a blank static
 * background. Classical computer vision, not a neural net: no pretrained
 * "watermark detector" model exists that's suitable to bundle here, and a
 * generic object detector (trained on real-world objects like people/cars)
 * has no concept of a graphic overlay to begin with.
 */
export async function detectWatermarkRegions(
  video: HTMLVideoElement,
  opts: DetectOptions = {},
): Promise<WatermarkDetection> {
  if (video.videoWidth === 0 || video.duration <= 0) return { regions: [] };

  const cfg = opts.thorough ? THOROUGH : QUICK;
  const grid = await sampleGrid(video, cfg.frames, cfg.analysisWidth, cfg.gridCols, opts.onProgress);
  if (grid.meanLum.length === 0) return { regions: [] };

  const { score, staticScore } = scoreGrid(grid);
  const maxStatic = staticScore.reduce((m, v) => Math.max(m, v), 0);
  if (maxStatic < STATIC_FLOOR) return { regions: [] };

  const workingScore = new Float64Array(score);
  const boxes: FractionRect[] = [];
  let firstDensity = 0;

  for (let k = 0; k < cfg.maxBoxes; k++) {
    const win = bestWindow(workingScore, grid.cols, grid.rows);
    if (!win) break;
    if (k === 0) {
      if (win.density < DENSITY_FLOOR) break;
      firstDensity = win.density;
    } else if (win.density < firstDensity * RELATIVE_DENSITY_FLOOR) {
      break;
    }
    boxes.push(windowToRect(win, grid.cols, grid.rows));
    for (let y = win.top; y < win.top + win.h; y++) {
      for (let x = win.left; x < win.left + win.w; x++) {
        workingScore[y * grid.cols + x] = -Infinity;
      }
    }
  }

  if (boxes.length === 0) return { regions: [] };

  const tileHint = detectTileHint(boxes);
  if (tileHint) return { regions: [boxes[0]], tileHint };
  return { regions: boxes };
}
