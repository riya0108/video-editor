import { guessVideoExtension, guessImageExtension } from "./format";
import { toFfmpegTimestamp } from "../time";
import { parseHexColor } from "../color";
import { planCutoutOverlay } from "./person-cutout-filter";
import type { CutoutFrame } from "../captions/person-cutout";
import type { BgReplaceMode, BgGradientDirection, ChromaSettings } from "../media/bg-removal-canvas";

/** Mirrors BgReplaceSettings but with export-time File references instead of live DOM elements. */
export interface BgReplaceExportSettings {
  mode: BgReplaceMode;
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

function isTransparentMode(mode: BgReplaceMode): boolean {
  return mode === "transparent";
}

/**
 * ffmpeg's `despill` filter only understands "green" or "blue" as a spill
 * color — map the user's arbitrary chroma hex onto whichever of those two
 * it's closer to (by hue), or null to skip despill entirely for screens far
 * from either (white/black/custom backdrops, where there's no color spill to
 * suppress). Removes the green/blue fringing that bleeds onto hair and
 * semi-transparent edges even after a clean colorkey pull.
 */
export function despillTypeFor(colorHex: string): "green" | "blue" | null {
  const c = parseHexColor(colorHex);
  const max = Math.max(c.r, c.g, c.b);
  if (max < 40) return null; // too dark to have a meaningful dominant hue
  if (c.g >= c.r && c.g >= c.b && c.g - Math.max(c.r, c.b) > 20) return "green";
  if (c.b >= c.r && c.b >= c.g && c.b - Math.max(c.r, c.g) > 20) return "blue";
  return null;
}

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
    // Decoder thread count, not just the encoder's: this build's core-mt wasm
    // can only reliably spin up its *initial* pthread pool — any later
    // on-demand worker request (e.g. from an auto-multithreaded h264 decode)
    // hangs forever in this sandbox with no error. Pinning decode to 1 thread
    // per input keeps total pthread demand inside the initial pool (mirrors
    // the same fix in build-editor-command.ts).
    inputArgs.push("-threads", "1", ...preArgs, "-i", name);
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
    if (input.replace.mode === "transparent") {
      // A fully transparent WxH canvas, same duration bound as the looped
      // image/video branches below. The `format=yuva420p` has to be baked
      // into the *same* lavfi source string — a `color` input's alpha gets
      // silently flattened to opaque the moment it crosses into a separate
      // `-filter_complex` step (verified empirically: chaining format here
      // instead of as a later `[idx:v]format=...` filter is what actually
      // keeps the alpha channel alive into the rest of the graph).
      const idx = addLavfiInput(`color=c=0x00000000:s=${W}x${H}:d=${durArg},format=yuva420p`);
      return `${idx}:v`;
    }
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
      // Looped image inputs have no inherent duration — without an explicit
      // bound here the filtergraph output never reaches EOF and ffmpeg.exec()
      // hangs forever (progress stuck at 0%).
      const idx = addFileInput(`bg.${ext}`, input.replace.imageFile, ["-loop", "1", "-t", durArg]);
      const out = newLabel("v");
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${out}]`);
      return out;
    }
    if (input.replace.mode === "video" && input.replace.videoFile) {
      const ext = guessVideoExtension(input.replace.videoFile);
      // Same unbounded-duration issue as the image branch above — a
      // `-stream_loop -1` input loops forever without an explicit `-t`.
      const idx = addFileInput(`bg.${ext}`, input.replace.videoFile, ["-stream_loop", "-1", "-t", durArg]);
      const out = newLabel("v");
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${out}]`);
      return out;
    }
    // "blur" — only the AI-cutout path reaches this branch (the chroma path
    // special-cases "blur" itself above, since colorkey also needs its own
    // copy of the raw stream). No other consumer needs `blurSourceLabel`
    // here, so blur it directly instead of splitting off a copy nothing
    // reads — an unconsumed split output is a hard ffmpeg filtergraph error
    // ("Filter split has an unconnected output"), not a silent no-op.
    const out = newLabel("v");
    filters.push(`[${blurSourceLabel}]avgblur=sizeX=40:sizeY=40[${out}]`);
    return out;
  };

  return { inputs, inputArgs, filters, newLabel, addFileInput, addLavfiInput, buildBackgroundLayer, mainIndex, W, H, durArg, trimmedDuration };
}

function finalizeArgs(
  inputArgs: string[],
  filters: string[],
  mainIndex: number,
  finalV: string,
  alpha: boolean,
): { args: string[]; outputName: string; outputMimeType: string } {
  const args = [...inputArgs];
  if (filters.length > 0) args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${finalV}]`);
  args.push("-map", `${mainIndex}:a?`);
  // Mirrors the full Video Editor's export: this build's multithreaded
  // filter execution has a severe contention bug with colorkey (and related
  // per-pixel filters) that otherwise never completes.
  args.push("-filter_threads", "1", "-filter_complex_threads", "1");
  if (alpha) {
    // ProRes 4444 in a .mov container — this build's only alpha encoder that
    // both carries real alpha end to end *and* actually plays back
    // natively. Tried in order: libvpx-vp9 hangs/crashes on any input in
    // this wasm build; libvpx (VP8) encodes and plays back fine but never
    // actually writes the alpha bitstream (decodes back fully opaque
    // despite the container correctly claiming alpha_mode=1); qtrle
    // (QuickTime Animation) does carry real alpha correctly, but two fatal
    // problems surfaced on a real (non-synthetic) clip: its RLE compression
    // produced a 515MB file for a 10-second 1080p screen recording, and —
    // worse — modern macOS's own AVFoundation stack couldn't decode it at
    // all (QuickLook hung indefinitely; confirmed directly). ProRes is
    // Apple's own professional codec, natively supported by
    // Premiere/DaVinci/Final Cut/iMovie *and* macOS itself (QuickLook
    // decoded a ProRes 4444 test file in under 2 seconds), and its DCT-based
    // compression is far more reasonable for real footage than qtrle's raw
    // RLE. No browser can preview a .mov inline either way (`canPlayType`
    // is empty for video/quicktime) — that's expected, matching how
    // reference tools like cutout.pro handle this same alpha-video gap.
    args.push("-pix_fmt", "yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4444", "-threads", "1", "-c:a", "aac");
    args.push("output.mov");
    return { args, outputName: "output.mov", outputMimeType: "video/quicktime" };
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "1", "-c:a", "aac");
  args.push("output.mp4");
  return { args, outputName: "output.mp4", outputMimeType: "video/mp4" };
}

/** Green-screen mode: ffmpeg's `colorkey` cuts the subject out, then it's composited over the chosen background (or, in "transparent" mode, exported as-is with real alpha). */
export function buildChromaRemovalCommand(input: BgRemovalCommandInput & { chroma: ChromaSettings }): BgRemovalCommandResult {
  const { inputs, inputArgs, filters, newLabel, buildBackgroundLayer, mainIndex } = buildCommandShell(input);
  const rawV = `${mainIndex}:v`;
  const alpha = isTransparentMode(input.replace.mode);

  // "blur" needs the raw main stream split before colorkey consumes it (an
  // unconsumed raw pad can only feed one filter chain); every other mode
  // (including "transparent", which skips building a background layer
  // entirely) leaves `rawV` as the sole consumer of the main stream.
  let keySource = rawV;
  let bgLabel: string | null = null;
  if (input.replace.mode === "blur") {
    const split1 = newLabel("v");
    const split2 = newLabel("v");
    filters.push(`[${rawV}]split=2[${split1}][${split2}]`);
    const blurOut = newLabel("v");
    filters.push(`[${split1}]avgblur=sizeX=40:sizeY=40[${blurOut}]`);
    bgLabel = blurOut;
    keySource = split2;
  } else if (!alpha) {
    bgLabel = buildBackgroundLayer(rawV);
  }

  // Pull the key first, *then* despill — despill on a saturated, pure key
  // color (the common case) desaturates it toward black, which moves it far
  // enough from the key color in colorkey's own distance metric that
  // colorkey would then fail to recognize it as background at all (verified
  // empirically: despill-before-colorkey left the background fully opaque
  // and black instead of keyed out). Despilling the *keyed* result instead
  // only touches residual green/blue fringing on the now-separated
  // subject's edges, which is what it's actually for.
  const color = input.chroma.colorHex.replace("#", "0x");
  const keyedRaw = newLabel("v");
  filters.push(`[${keySource}]colorkey=${color}:${input.chroma.similarity}:${input.chroma.blend}[${keyedRaw}]`);

  const despillType = despillTypeFor(input.chroma.colorHex);
  let keyedColor = keyedRaw;
  if (despillType) {
    const despilled = newLabel("v");
    filters.push(`[${keyedRaw}]despill=type=${despillType}[${despilled}]`);
    keyedColor = despilled;
  }

  const keyed = newLabel("v");
  filters.push(`[${keyedColor}]format=yuva420p[${keyed}]`);

  const finalLabel = alpha
    ? keyed
    : (() => {
        const composited = newLabel("v");
        filters.push(`[${bgLabel}][${keyed}]overlay=shortest=1[${composited}]`);
        return composited;
      })();

  return { inputs, ...finalizeArgs(inputArgs, filters, mainIndex, finalLabel, alpha) };
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
  const alpha = isTransparentMode(input.replace.mode);

  // "transparent" already builds its background layer as a real WxH alpha
  // canvas (see buildCommandShell) — the overlay chain below is identical
  // either way, it just ends up compositing onto transparency instead of an
  // opaque layer.
  const bgLabel = buildBackgroundLayer(`${mainIndex}:v`);

  const plan = planCutoutOverlay({
    frames: input.cutoutFrames,
    timeOffset: input.trimStart,
    windowStart: 0,
    windowEnd: trimmedDuration,
    targetWidth: W,
    targetHeight: H,
    preserveAlpha: alpha,
  });
  if (!plan) throw new Error("NO_SUBJECT");

  let firstCutoutIdx = -1;
  for (const cutout of plan.inputs) {
    const idx = addFileInput(cutout.name, cutout.data, ["-loop", "1"]);
    if (firstCutoutIdx === -1) firstCutoutIdx = idx;
  }
  const { filters: overlayFilters, outLabel } = plan.buildFilters(firstCutoutIdx, bgLabel, newLabel);
  filters.push(...overlayFilters);

  // Guarantee an alpha-capable pixel format reaches the encoder — overlay's
  // own format negotiation is usually enough, but this makes it explicit
  // rather than relying on it picking yuva420p on its own.
  let finalLabel = outLabel;
  if (alpha) {
    const forced = newLabel("v");
    filters.push(`[${outLabel}]format=yuva420p[${forced}]`);
    finalLabel = forced;
  }

  return { inputs, ...finalizeArgs(inputArgs, filters, mainIndex, finalLabel, alpha) };
}
