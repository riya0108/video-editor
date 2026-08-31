import { guessVideoExtension, guessImageExtension } from "./format";
import { toFfmpegTimestamp } from "../time";
import { parseHexColor } from "../color";
import { planCutoutOverlay } from "./person-cutout-filter";
import type { CutoutFrame } from "../captions/person-cutout";
import type { BgReplaceMode, BgGradientDirection, ChromaSettings } from "../media/bg-removal-canvas";

/** Mirrors BgReplaceSettings but with export-time File references instead of live DOM elements. */
export interface BgReplaceExportSettings {
  mode: Exclude<BgReplaceMode, "transparent">;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: BgGradientDirection;
  imageFile: File | null;
  videoFile: File | null;
}

export interface BgRemovalCommandInput {
  file: File;
  width: number;
  height: number;
  trimStart: number;
  trimEnd: number;
  replace: BgReplaceExportSettings;
}

export interface BgRemovalCommandResult {
  inputs: { name: string; data: File | Blob | string }[];
  args: string[];
  outputName: string;
  outputMimeType: string;
}

/** Video export can't produce real alpha (no vpx/webm encoder in this app's ffmpeg-wasm build), so every mode composites onto something opaque — unlike the image pipeline, which can output a genuinely transparent PNG. */
function buildCommandShell(input: BgRemovalCommandInput) {
  const inputs: { name: string; data: File | Blob | string }[] = [];
  const inputArgs: string[] = [];
  let inputCount = 0;
  let labelCount = 0;

  const newLabel = (prefix: "v") => {
    labelCount += 1;
    return `${prefix}${labelCount}`;
  };
  const addFileInput = (name: string, data: File | Blob, preArgs: string[] = []): number => {
    inputArgs.push(...preArgs, "-i", name);
    inputs.push({ name, data });
    const idx = inputCount;
    inputCount += 1;
    return idx;
  };
  const addLavfiInput = (source: string, preArgs: string[] = []): number => {
    inputArgs.push(...preArgs, "-f", "lavfi", "-i", source);
    const idx = inputCount;
    inputCount += 1;
    return idx;
  };

  const filters: string[] = [];
  const { width: W, height: H } = input;
  const trimmedDuration = Math.max(0, input.trimEnd - input.trimStart);
  const durArg = (trimmedDuration + 1).toFixed(2);
  const mainExt = guessVideoExtension(input.file);
  const mainIndex = addFileInput(`input.${mainExt}`, input.file, [
    "-ss",
    toFfmpegTimestamp(input.trimStart),
    "-t",
    toFfmpegTimestamp(trimmedDuration),
  ]);

  /** Builds the chosen replacement as its own full-size (W×H) video layer, returning its label. `blurSourceLabel` is a *raw, not-yet-consumed* stream reference — required for "blur" mode, which blurs that source in place of a separate asset. */
  const buildBackgroundLayer = (blurSourceLabel: string): string => {
    if (input.replace.mode === "color") {
      const idx = addLavfiInput(`color=c=${input.replace.color.replace("#", "0x")}:s=${W}x${H}:d=${durArg}`);
      return `${idx}:v`;
    }
    if (input.replace.mode === "gradient") {
      const from = parseHexColor(input.replace.gradientFrom);
      const to = parseHexColor(input.replace.gradientTo);
      const t =
        input.replace.gradientDirection === "horizontal"
          ? "(X/W)"
          : input.replace.gradientDirection === "diagonal"
            ? "((X+Y)/(W+H))"
            : "(Y/H)";
      const expr = (c1: number, c2: number) => `${c1}+(${c2}-${c1})*${t}`;
      const idx = addLavfiInput(`color=c=black:s=${W}x${H}:d=${durArg}`);
      const out = newLabel("v");
      filters.push(`[${idx}:v]geq=r='${expr(from.r, to.r)}':g='${expr(from.g, to.g)}':b='${expr(from.b, to.b)}'[${out}]`);
      return out;
    }
    if (input.replace.mode === "image" && input.replace.imageFile) {
      const ext = guessImageExtension(input.replace.imageFile);
      const idx = addFileInput(`bg.${ext}`, input.replace.imageFile, ["-loop", "1"]);
      const out = newLabel("v");
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${out}]`);
      return out;
    }
    if (input.replace.mode === "video" && input.replace.videoFile) {
      const ext = guessVideoExtension(input.replace.videoFile);
      const idx = addFileInput(`bg.${ext}`, input.replace.videoFile, ["-stream_loop", "-1"]);
      const out = newLabel("v");
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${out}]`);
      return out;
    }
    // "blur" — split the raw source so both the blur pass and whatever
    // consumes `blurSourceLabel` afterwards each get their own copy, since a
    // filtergraph pad can only feed one consumer directly.
    const split1 = newLabel("v");
    const split2 = newLabel("v");
    filters.push(`[${blurSourceLabel}]split=2[${split1}][${split2}]`);
    const out = newLabel("v");
    filters.push(`[${split1}]avgblur=sizeX=40:sizeY=40[${out}]`);
    return out;
  };

  return { inputs, inputArgs, filters, newLabel, addFileInput, addLavfiInput, buildBackgroundLayer, mainIndex, W, H, durArg, trimmedDuration };
}

function finalizeArgs(inputArgs: string[], filters: string[], mainIndex: number, finalV: string): string[] {
  const args = [...inputArgs];
  if (filters.length > 0) args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${finalV}]`);
  args.push("-map", `${mainIndex}:a?`);
  // Mirrors the full Video Editor's export: this build's multithreaded
  // filter execution has a severe contention bug with colorkey (and related
  // per-pixel filters) that otherwise never completes.
  args.push("-filter_threads", "1", "-filter_complex_threads", "1");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "1", "-c:a", "aac");
  args.push("output.mp4");
  return args;
}

/** Green-screen mode: ffmpeg's `colorkey` cuts the subject out, then it's composited over the chosen background. */
export function buildChromaRemovalCommand(input: BgRemovalCommandInput & { chroma: ChromaSettings }): BgRemovalCommandResult {
  const { inputs, inputArgs, filters, newLabel, buildBackgroundLayer, mainIndex } = buildCommandShell(input);
  const rawV = `${mainIndex}:v`;

  // "blur" needs the raw main stream split before colorkey consumes it (an
  // unconsumed raw pad can only feed one filter chain); every other mode
  // builds its background from a separate input, so `rawV` stays free.
  let keySource = rawV;
  let bgLabel: string;
  if (input.replace.mode === "blur") {
    const split1 = newLabel("v");
    const split2 = newLabel("v");
    filters.push(`[${rawV}]split=2[${split1}][${split2}]`);
    const blurOut = newLabel("v");
    filters.push(`[${split1}]avgblur=sizeX=40:sizeY=40[${blurOut}]`);
    bgLabel = blurOut;
    keySource = split2;
  } else {
    bgLabel = buildBackgroundLayer(rawV);
  }

  const color = input.chroma.colorHex.replace("#", "0x");
  const keyed = newLabel("v");
  filters.push(`[${keySource}]colorkey=${color}:${input.chroma.similarity}:${input.chroma.blend},format=yuva420p[${keyed}]`);

  const composited = newLabel("v");
  filters.push(`[${bgLabel}][${keyed}]overlay=shortest=1[${composited}]`);

  return {
    inputs,
    args: finalizeArgs(inputArgs, filters, mainIndex, composited),
    outputName: "output.mp4",
    outputMimeType: "video/mp4",
  };
}

/**
 * AI ("no green screen") mode: a sampled chain of person-cutout frames
 * (already alpha-punched PNGs from `generatePersonCutouts`) overlaid on top
 * of the chosen background for their respective time windows — the same
 * `planCutoutOverlay` machinery the "behind a person" caption style uses,
 * just layered over a background instead of over caption text.
 */
export function buildAiCutoutRemovalCommand(input: BgRemovalCommandInput & { cutoutFrames: CutoutFrame[] }): BgRemovalCommandResult {
  const { inputs, inputArgs, filters, newLabel, addFileInput, buildBackgroundLayer, mainIndex, W, H, trimmedDuration } = buildCommandShell(input);
  const rawV = `${mainIndex}:v`;

  const bgLabel = buildBackgroundLayer(rawV);

  const plan = planCutoutOverlay({
    frames: input.cutoutFrames,
    timeOffset: input.trimStart,
    windowStart: 0,
    windowEnd: trimmedDuration,
    targetWidth: W,
    targetHeight: H,
  });
  if (!plan) throw new Error("NO_SUBJECT");

  let firstCutoutIdx = -1;
  for (const cutout of plan.inputs) {
    const idx = addFileInput(cutout.name, cutout.data, ["-loop", "1"]);
    if (firstCutoutIdx === -1) firstCutoutIdx = idx;
  }
  const { filters: overlayFilters, outLabel } = plan.buildFilters(firstCutoutIdx, bgLabel, newLabel);
  filters.push(...overlayFilters);

  return {
    inputs,
    args: finalizeArgs(inputArgs, filters, mainIndex, outLabel),
    outputName: "output.mp4",
    outputMimeType: "video/mp4",
  };
}
