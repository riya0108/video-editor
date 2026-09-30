import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { ffmpegEngine } from "../ffmpeg/engine";
import { decodeTiffToRgba } from "./tiff-encoder";

export type ExportCheckId =
  | "file-exists"
  | "file-readable"
  | "resolution"
  | "frame-rate"
  | "alpha-exists"
  | "alpha-transparency"
  | "no-black-flatten";

export interface ExportCheck {
  id: ExportCheckId;
  label: string;
  passed: boolean;
  /** True when this check doesn't apply to this particular export (e.g. frame rate for a still image) rather than having actually failed. */
  skipped?: boolean;
  detail?: string;
}

export interface ExportValidationReport {
  passed: boolean;
  checks: ExportCheck[];
}

const CHECK_LABELS: Record<ExportCheckId, string> = {
  "file-exists": "File exists",
  "file-readable": "File is readable",
  resolution: "Resolution matches",
  "frame-rate": "Frame rate matches",
  "alpha-exists": "Alpha channel present",
  "alpha-transparency": "Alpha contains real transparency",
  "no-black-flatten": "No unexpected black background",
};

function finish(checks: ExportCheck[]): ExportValidationReport {
  return { passed: checks.every((c) => c.skipped || c.passed), checks };
}

/** Fills in the remaining checks as skipped, e.g. once an earlier check (file readable, alpha present) has already failed and later ones can't meaningfully run. */
function skipRemaining(ids: ExportCheckId[], detail?: string): ExportCheck[] {
  return ids.map((id) => ({ id, label: CHECK_LABELS[id], passed: false, skipped: true, detail }));
}

// Thresholds are deliberately loose — this is a smoke test for gross
// regressions (alpha silently dropped, background flattened to opaque
// black), not a pixel-perfect diff against a reference render.
const TRANSPARENT_ALPHA = 12;
const OPAQUE_ALPHA = 243;
const BLACK_RGB = 10;

interface AlphaAnalysis {
  transparentFraction: number;
  blackFlattenFraction: number;
}

/** Scans an RGBA buffer once for both "is there real transparency" and "are the opaque pixels suspiciously all pure black" (the signature of alpha getting silently flattened away). */
export function analyzeRgba(rgba: Uint8Array | Uint8ClampedArray, pixelCount: number): AlphaAnalysis {
  let transparent = 0;
  let opaque = 0;
  let opaqueBlack = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a <= TRANSPARENT_ALPHA) transparent++;
    if (a >= OPAQUE_ALPHA) {
      opaque++;
      if (rgba[o] <= BLACK_RGB && rgba[o + 1] <= BLACK_RGB && rgba[o + 2] <= BLACK_RGB) opaqueBlack++;
    }
  }
  return {
    transparentFraction: pixelCount > 0 ? transparent / pixelCount : 0,
    blackFlattenFraction: opaque > 0 ? opaqueBlack / opaque : 0,
  };
}

function alphaChecksFromAnalysis(analysis: AlphaAnalysis, pixelLabel: string): ExportCheck[] {
  return [
    {
      id: "alpha-transparency",
      label: CHECK_LABELS["alpha-transparency"],
      passed: analysis.transparentFraction > 0.001,
      detail: `${(analysis.transparentFraction * 100).toFixed(1)}% of ${pixelLabel} pixels are transparent`,
    },
    {
      id: "no-black-flatten",
      label: CHECK_LABELS["no-black-flatten"],
      // Flags the specific shape of a flatten-to-black bug: almost nothing
      // is really transparent, and almost everything that IS opaque is
      // pure black — i.e. the alpha channel looks structurally present but
      // never actually punched through anywhere.
      passed: !(analysis.transparentFraction < 0.02 && analysis.blackFlattenFraction > 0.6),
      detail:
        analysis.blackFlattenFraction > 0.6
          ? `${(analysis.blackFlattenFraction * 100).toFixed(0)}% of opaque ${pixelLabel} pixels are near-black`
          : undefined,
    },
  ];
}

const ALPHA_CAPABLE_IMAGE_TYPES = new Set(["image/png", "image/webp", "image/tiff"]);

/**
 * Verifies a still-image export: exists, decodes, matches the expected
 * resolution, and — when alpha was requested — actually carries real
 * per-pixel transparency rather than silently flattening to opaque.
 */
export async function validateImageExport(
  blob: Blob,
  expected: { width: number; height: number; expectAlpha: boolean },
): Promise<ExportValidationReport> {
  const checks: ExportCheck[] = [
    { id: "file-exists", label: CHECK_LABELS["file-exists"], passed: blob.size > 0, detail: `${blob.size} bytes` },
  ];
  if (blob.size === 0) {
    return finish([...checks, ...skipRemaining(["file-readable", "resolution", "frame-rate", "alpha-exists", "alpha-transparency", "no-black-flatten"])]);
  }

  // No browser exposes a native TIFF decoder (createImageBitmap rejects it
  // everywhere) — read it back with the matching hand-rolled decoder
  // instead of the canvas/ImageBitmap path every other format below uses.
  if (blob.type === "image/tiff") {
    return validateTiffExport(blob, expected, checks);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    checks.push({ id: "file-readable", label: CHECK_LABELS["file-readable"], passed: false, detail: "Couldn't decode the exported image." });
    return finish([...checks, ...skipRemaining(["resolution", "frame-rate", "alpha-exists", "alpha-transparency", "no-black-flatten"])]);
  }
  checks.push({ id: "file-readable", label: CHECK_LABELS["file-readable"], passed: true });

  checks.push({
    id: "resolution",
    label: CHECK_LABELS.resolution,
    passed: bitmap.width === expected.width && bitmap.height === expected.height,
    detail: `${bitmap.width}×${bitmap.height} (expected ${expected.width}×${expected.height})`,
  });
  checks.push({ id: "frame-rate", label: CHECK_LABELS["frame-rate"], passed: true, skipped: true, detail: "Not applicable to still images" });

  if (!expected.expectAlpha) {
    checks.push({ id: "alpha-exists", label: CHECK_LABELS["alpha-exists"], passed: true, skipped: true, detail: "Not requested for this export" });
    checks.push({ id: "alpha-transparency", label: CHECK_LABELS["alpha-transparency"], passed: true, skipped: true, detail: "Not requested for this export" });
    checks.push({ id: "no-black-flatten", label: CHECK_LABELS["no-black-flatten"], passed: true, skipped: true });
    bitmap.close();
    return finish(checks);
  }

  checks.push({
    id: "alpha-exists",
    label: CHECK_LABELS["alpha-exists"],
    passed: ALPHA_CAPABLE_IMAGE_TYPES.has(blob.type),
    detail: `Format: ${blob.type || "unknown"}`,
  });
  if (!ALPHA_CAPABLE_IMAGE_TYPES.has(blob.type)) {
    bitmap.close();
    return finish([...checks, ...skipRemaining(["alpha-transparency", "no-black-flatten"], "The exported format doesn't support alpha.")]);
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return finish([...checks, ...skipRemaining(["alpha-transparency", "no-black-flatten"], "Canvas isn't available to inspect pixels.")]);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const analysis = analyzeRgba(data, canvas.width * canvas.height);
  checks.push(...alphaChecksFromAnalysis(analysis, "image"));

  return finish(checks);
}

async function validateTiffExport(
  blob: Blob,
  expected: { width: number; height: number; expectAlpha: boolean },
  checks: ExportCheck[],
): Promise<ExportValidationReport> {
  const buffer = await blob.arrayBuffer();
  const decoded = decodeTiffToRgba(buffer);
  if (!decoded) {
    checks.push({ id: "file-readable", label: CHECK_LABELS["file-readable"], passed: false, detail: "Couldn't parse the exported TIFF's structure." });
    return finish([...checks, ...skipRemaining(["resolution", "frame-rate", "alpha-exists", "alpha-transparency", "no-black-flatten"])]);
  }
  checks.push({ id: "file-readable", label: CHECK_LABELS["file-readable"], passed: true });

  checks.push({
    id: "resolution",
    label: CHECK_LABELS.resolution,
    passed: decoded.width === expected.width && decoded.height === expected.height,
    detail: `${decoded.width}×${decoded.height} (expected ${expected.width}×${expected.height})`,
  });
  checks.push({ id: "frame-rate", label: CHECK_LABELS["frame-rate"], passed: true, skipped: true, detail: "Not applicable to still images" });

  if (!expected.expectAlpha) {
    checks.push({ id: "alpha-exists", label: CHECK_LABELS["alpha-exists"], passed: true, skipped: true, detail: "Not requested for this export" });
    checks.push({ id: "alpha-transparency", label: CHECK_LABELS["alpha-transparency"], passed: true, skipped: true, detail: "Not requested for this export" });
    checks.push({ id: "no-black-flatten", label: CHECK_LABELS["no-black-flatten"], passed: true, skipped: true });
    return finish(checks);
  }

  checks.push({ id: "alpha-exists", label: CHECK_LABELS["alpha-exists"], passed: decoded.hasAlpha, detail: "Format: image/tiff (ExtraSamples)" });
  if (!decoded.hasAlpha) {
    return finish([...checks, ...skipRemaining(["alpha-transparency", "no-black-flatten"], "The exported TIFF has no ExtraSamples (alpha) channel.")]);
  }

  const analysis = analyzeRgba(decoded.rgba, decoded.width * decoded.height);
  checks.push(...alphaChecksFromAnalysis(analysis, "image"));
  return finish(checks);
}

const ALPHA_PIX_FMT_EXACT = new Set(["rgba", "bgra", "argb", "abgr", "ya8", "ya16le", "ya16be"]);

/**
 * Whether an ffmpeg pixel format name carries an alpha channel. Matched by
 * prefix/family rather than an exact list of every bit-depth variant —
 * ffmpeg's yuva/gbrap families each come in 8/9/10/12/16-bit le/be flavors
 * (e.g. `yuva444p12le`, which prores_ks actually chose for a "4444"-profile
 * encode in testing here even though yuva444p10le was requested — encoders
 * are free to pick their own internal bit depth), and a fixed list drifts
 * out of date the moment a different encoder or profile picks a variant
 * that wasn't enumerated.
 */
export function isAlphaPixFmt(pixFmt: string): boolean {
  return ALPHA_PIX_FMT_EXACT.has(pixFmt) || pixFmt.startsWith("yuva") || pixFmt.startsWith("gbrap");
}

interface ProbedVideo {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSec: number | null;
  pixFmt: string | null;
}

/** Parses ffmpeg's own `-i` stream-info log lines — the same source of truth the real export step's demuxer/encoder used, no separate probing library needed. */
export function parseProbeLogs(logs: string[]): ProbedVideo {
  const text = logs.join("\n");
  const videoLine = logs.find((l) => /Stream #\d+:\d+.*: Video:/.test(l)) ?? "";
  const wh = videoLine.match(/(\d{2,6})x(\d{2,6})/);
  const fpsMatch = videoLine.match(/([\d.]+)\s*fps/);
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  // The pix_fmt token sits right after the codec description's closing
  // paren and right before the WxH — e.g. "...(ap4h / 0x68347061),
  // yuva444p10le(tv, progressive), 1280x720, ...".
  const pixFmtMatch = videoLine.match(/\),\s*([a-z0-9_]+)(?:\([^)]*\))?,\s*\d+x\d+/);

  return {
    width: wh ? Number(wh[1]) : null,
    height: wh ? Number(wh[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    durationSec: durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null,
    pixFmt: pixFmtMatch?.[1] ?? null,
  };
}

/** Runs ffmpeg's own `-i` probe against any video blob and parses its stream info — shared by validateVideoExport (checking the output) and callers that want the *source*'s own fps/resolution ahead of time (see probeVideoMeta). Leaves the file on the virtual FS; the caller owns cleanup. */
async function probeWithFfmpeg(ffmpeg: FFmpeg, blob: Blob, inputName: string): Promise<ProbedVideo> {
  const logs: string[] = [];
  const logHandler = ({ message }: { message: string }) => logs.push(message);
  ffmpeg.on("log", logHandler);
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(blob));
    try {
      await ffmpeg.exec(["-hide_banner", "-i", inputName]);
    } catch {
      // Exits non-zero because no output was given — the stream listing is
      // already in the logs by the time that happens.
    }
    return parseProbeLogs(logs);
  } finally {
    ffmpeg.off("log", logHandler);
  }
}

/**
 * Probes a video file's own resolution/fps/duration before exporting it —
 * lets a caller pass the *source*'s real fps as `validateVideoExport`'s
 * `expected.fps`, since none of this app's ffmpeg export commands set an
 * explicit output framerate (no `-r`, no `fps` filter) and so are expected
 * to simply preserve whatever the input already had.
 */
export async function probeVideoMeta(blob: Blob): Promise<{ width: number | null; height: number | null; fps: number | null; durationSec: number | null }> {
  const inputName = "probe_source.bin";
  return ffmpegEngine.exclusive(async (ffmpeg) => {
    try {
      return await probeWithFfmpeg(ffmpeg, blob, inputName);
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => {});
    }
  });
}

/**
 * Verifies a video export via ffmpeg itself (the same engine that produced
 * it) rather than a browser `<video>` element — alpha-carrying formats like
 * ProRes 4444 in a .mov aren't decodable by any browser's native video
 * pipeline (`canPlayType` is empty for video/quicktime), so there's no
 * other reliable way to actually look at the encoded pixels from here.
 */
export async function validateVideoExport(
  blob: Blob,
  expected: { width: number; height: number; fps?: number; expectAlpha: boolean },
): Promise<ExportValidationReport> {
  const checks: ExportCheck[] = [
    { id: "file-exists", label: CHECK_LABELS["file-exists"], passed: blob.size > 0, detail: `${blob.size} bytes` },
  ];
  if (blob.size === 0) {
    return finish([...checks, ...skipRemaining(["file-readable", "resolution", "frame-rate", "alpha-exists", "alpha-transparency", "no-black-flatten"])]);
  }

  const inputName = "validate_input.bin";
  return ffmpegEngine.exclusive(async (ffmpeg) => {
    try {
      const probed = await probeWithFfmpeg(ffmpeg, blob, inputName);

      const readable = probed.width !== null && probed.height !== null;
      checks.push({
        id: "file-readable",
        label: CHECK_LABELS["file-readable"],
        passed: readable,
        detail: readable ? undefined : "ffmpeg couldn't parse this file's stream info.",
      });
      if (!readable) {
        return finish([...checks, ...skipRemaining(["resolution", "frame-rate", "alpha-exists", "alpha-transparency", "no-black-flatten"])]);
      }
      const width = probed.width as number;
      const height = probed.height as number;

      checks.push({
        id: "resolution",
        label: CHECK_LABELS.resolution,
        passed: width === expected.width && height === expected.height,
        detail: `${width}×${height} (expected ${expected.width}×${expected.height})`,
      });

      if (expected.fps) {
        const fpsMatches = probed.fps !== null && Math.abs(probed.fps - expected.fps) < 0.6;
        checks.push({
          id: "frame-rate",
          label: CHECK_LABELS["frame-rate"],
          passed: fpsMatches,
          detail: probed.fps !== null ? `${probed.fps} fps (expected ~${expected.fps.toFixed(2)} fps)` : "Couldn't determine the output frame rate.",
        });
      } else {
        checks.push({ id: "frame-rate", label: CHECK_LABELS["frame-rate"], passed: true, skipped: true, detail: "No expected frame rate provided" });
      }

      if (!expected.expectAlpha) {
        checks.push({ id: "alpha-exists", label: CHECK_LABELS["alpha-exists"], passed: true, skipped: true, detail: "Not requested for this export" });
        checks.push({ id: "alpha-transparency", label: CHECK_LABELS["alpha-transparency"], passed: true, skipped: true, detail: "Not requested for this export" });
        checks.push({ id: "no-black-flatten", label: CHECK_LABELS["no-black-flatten"], passed: true, skipped: true });
        return finish(checks);
      }

      const alphaFmt = probed.pixFmt !== null && isAlphaPixFmt(probed.pixFmt);
      checks.push({
        id: "alpha-exists",
        label: CHECK_LABELS["alpha-exists"],
        passed: alphaFmt,
        detail: `Pixel format: ${probed.pixFmt ?? "unknown"}`,
      });
      if (!alphaFmt) {
        return finish([...checks, ...skipRemaining(["alpha-transparency", "no-black-flatten"], "The exported pixel format doesn't carry alpha.")]);
      }

      const durationSec = probed.durationSec ?? 1;
      const rgba = await extractMidFrameRgba(ffmpeg, inputName, durationSec, width, height);
      if (!rgba) {
        checks.push({
          id: "alpha-transparency",
          label: CHECK_LABELS["alpha-transparency"],
          passed: false,
          detail: "Couldn't decode a frame to verify pixel-level transparency.",
        });
        checks.push(...skipRemaining(["no-black-flatten"]));
        return finish(checks);
      }
      const analysis = analyzeRgba(rgba, width * height);
      checks.push(...alphaChecksFromAnalysis(analysis, "sampled-frame"));

      return finish(checks);
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => {});
    }
  });
}

async function extractMidFrameRgba(
  ffmpeg: FFmpeg,
  inputName: string,
  durationSec: number,
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  const seekTime = Math.max(0, durationSec / 2);
  const outName = "validate_frame.raw";
  try {
    const exitCode = await ffmpeg.exec([
      // Pinning decode to 1 thread — this build's core-mt wasm can only
      // reliably spin up its *initial* pthread pool; an on-demand worker
      // request from an auto-multithreaded decode (ProRes included) hangs
      // forever here with no error (same fix as bg-removal-command.ts).
      "-threads",
      "1",
      "-ss",
      seekTime.toFixed(2),
      "-i",
      inputName,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      outName,
    ]);
    if (exitCode !== 0) return null;
    const bytes = (await ffmpeg.readFile(outName)) as Uint8Array;
    if (bytes.length < width * height * 4) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}
