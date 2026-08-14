import {
  guessVideoExtension,
  guessImageExtension,
  guessAudioExtension,
} from "./format";
import { evenRound } from "../geometry";
import { toFfmpegTimestamp } from "../time";
import { escapeDrawtext } from "./drawtext";
import { anchorExpr } from "./overlay-position";
import { getTextFont } from "./fonts";
import { positionExprs } from "./text-position";
import { VOICE_REMOVER_FILTER, noiseReductionFilter, atempoChain } from "./audio-filters";
import { resolveQualityTarget, upscaleFilter } from "./upscale-filter";
import { planCutoutOverlay } from "./person-cutout-filter";
import { buildCaptionsFilter, remapCuesToTrim } from "../captions/build-captions-filter";
import { measureKaraokeLayouts } from "../captions/karaoke-layout";
import type { CutoutFrame } from "../captions/person-cutout";
import type { CaptionCue, CaptionStyle } from "../captions/types";
import type {
  EditorChromaKeyState,
  EditorCropState,
  EditorBgBlurState,
  EditorLogoState,
  EditorMusicState,
  EditorExtraClipState,
  EditorFadeState,
  EditorTextState,
  EditorQualityState,
  BgAspect,
} from "./editor-state";
import type { OverlayLayer } from "./overlay-layer";

const ASPECT_SIZES: Record<BgAspect, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
};

const ANIM_DURATION = 0.6;
const SLIDE_DISTANCE = 100;

export interface BuildEditorCommandInput {
  videoFile: File;
  videoWidth: number;
  videoHeight: number;
  trimStart: number;
  trimEnd: number;
  crop: EditorCropState;
  logo: EditorLogoState;
  chromaKey: EditorChromaKeyState;
  bgBlur: EditorBgBlurState;
  speed: number;
  fade: EditorFadeState;
  voiceRemover: boolean;
  noise: { enabled: boolean; strength: number };
  music: EditorMusicState;
  overlays: OverlayLayer[];
  extraClip: EditorExtraClipState;
  text: EditorTextState;
  captions: { enabled: boolean; cues: CaptionCue[]; style: CaptionStyle };
  personCutoutFrames: CutoutFrame[];
  quality: EditorQualityState;
}

export interface BuildEditorCommandResult {
  inputs: { name: string; data: File | Blob }[];
  args: string[];
  outputName: string;
}

export async function buildEditorCommand(state: BuildEditorCommandInput): Promise<BuildEditorCommandResult> {
  const inputs: { name: string; data: File | Blob }[] = [];
  const inputArgs: string[] = [];
  let inputCount = 0;
  let labelCount = 0;

  const newLabel = (prefix: "v" | "a") => {
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

  // ---- Main input: trim baked in at demux level so it's unaffected by
  // any later concat with an intro/outro clip. ----
  const mainExt = guessVideoExtension(state.videoFile);
  const trimmedDuration = Math.max(0, state.trimEnd - state.trimStart);
  const mainIndex = addFileInput(`input.${mainExt}`, state.videoFile, [
    "-ss",
    toFfmpegTimestamp(state.trimStart),
    "-t",
    toFfmpegTimestamp(trimmedDuration),
  ]);

  let vLabel = `${mainIndex}:v`;
  const vLabelIsRaw = () => vLabel === `${mainIndex}:v`;
  let currentW = state.videoWidth;
  let currentH = state.videoHeight;

  // ---- Remove logo (before crop, so the box the user drew against the
  // original preview still points at the right pixels). ----
  if (state.logo.enabled) {
    const w = evenRound(state.logo.rect.w * currentW);
    const h = evenRound(state.logo.rect.h * currentH);
    const x = evenRound(state.logo.rect.x * currentW);
    const y = evenRound(state.logo.rect.y * currentH);
    const out = newLabel("v");
    filters.push(`[${vLabel}]delogo=x=${x}:y=${y}:w=${w}:h=${h}[${out}]`);
    vLabel = out;
  }

  // ---- Crop ----
  if (state.crop.enabled) {
    const w = evenRound(state.crop.rect.w * currentW);
    const h = evenRound(state.crop.rect.h * currentH);
    const x = evenRound(state.crop.rect.x * currentW);
    const y = evenRound(state.crop.rect.y * currentH);
    const out = newLabel("v");
    filters.push(`[${vLabel}]crop=${w}:${h}:${x}:${y}[${out}]`);
    vLabel = out;
    currentW = w;
    currentH = h;
  }

  // ---- Chroma key / remove a color ----
  if (state.chromaKey.enabled) {
    const color = state.chromaKey.colorHex.replace("#", "0x");
    const keyed = newLabel("v");
    filters.push(
      `[${vLabel}]colorkey=${color}:${state.chromaKey.similarity}:${state.chromaKey.blend},format=yuva420p[${keyed}]`,
    );

    let bgLabel: string;
    if (state.chromaKey.replace === "image" && state.chromaKey.replaceImageFile) {
      const imgExt = guessImageExtension(state.chromaKey.replaceImageFile);
      const idx = addFileInput(`chromabg.${imgExt}`, state.chromaKey.replaceImageFile, ["-loop", "1"]);
      const scaled = newLabel("v");
      filters.push(
        `[${idx}:v]scale=${currentW}:${currentH}:force_original_aspect_ratio=increase,crop=${currentW}:${currentH}[${scaled}]`,
      );
      bgLabel = scaled;
    } else if (state.chromaKey.replace === "video" && state.chromaKey.replaceVideoFile) {
      const vidExt = guessVideoExtension(state.chromaKey.replaceVideoFile);
      const idx = addFileInput(`chromabg.${vidExt}`, state.chromaKey.replaceVideoFile, ["-stream_loop", "-1"]);
      const scaled = newLabel("v");
      filters.push(
        `[${idx}:v]scale=${currentW}:${currentH}:force_original_aspect_ratio=increase,crop=${currentW}:${currentH}[${scaled}]`,
      );
      bgLabel = scaled;
    } else {
      const color2 = state.chromaKey.replaceColorHex.replace("#", "0x");
      const idx = addLavfiInput(`color=c=${color2}:s=${currentW}x${currentH}:d=${(trimmedDuration + 1).toFixed(2)}`);
      bgLabel = `${idx}:v`;
    }

    const composited = newLabel("v");
    filters.push(`[${bgLabel}][${keyed}]overlay=shortest=1[${composited}]`);
    vLabel = composited;
  }

  // ---- Blurred-background padding (fit into a target aspect ratio) ----
  if (state.bgBlur.enabled) {
    const [targetW, targetH] = ASPECT_SIZES[state.bgBlur.aspect];
    const split1 = newLabel("v");
    const split2 = newLabel("v");
    filters.push(`[${vLabel}]split=2[${split1}][${split2}]`);
    const bgOut = newLabel("v");
    filters.push(
      `[${split1}]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},avgblur=sizeX=40:sizeY=40[${bgOut}]`,
    );
    const fgOut = newLabel("v");
    filters.push(`[${split2}]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[${fgOut}]`);
    const composited = newLabel("v");
    filters.push(`[${bgOut}][${fgOut}]overlay=(W-w)/2:(H-h)/2[${composited}]`);
    vLabel = composited;
    currentW = targetW;
    currentH = targetH;
  }

  // ---- Captions (burned in before Speed, so filter-time `t` here still
  // matches trim-relative real seconds — same base remapCuesToTrim shifts
  // cue timestamps into). ----
  if (state.captions.enabled && state.captions.cues.length > 0) {
    const font = getTextFont(state.captions.style.fontId);
    const fontBlob = await fetch(font.url).then((r) => r.blob());
    inputs.push({ name: font.ffmpegName, data: fontBlob });

    const remapped = remapCuesToTrim(state.captions.cues, state.trimStart, state.trimEnd);
    const karaokeLayouts = state.captions.style.karaoke
      ? await measureKaraokeLayouts(remapped, state.captions.style, font.cssFontFamily, currentW)
      : undefined;
    const capFilter = buildCaptionsFilter(remapped, state.captions.style, font.ffmpegName, karaokeLayouts);
    if (capFilter) {
      const out = newLabel("v");
      filters.push(`[${vLabel}]${capFilter}[${out}]`);
      vLabel = out;
    }

    if (state.captions.style.occludeByPerson && state.personCutoutFrames.length > 0) {
      const plan = planCutoutOverlay({
        frames: state.personCutoutFrames,
        timeOffset: state.trimStart,
        windowStart: 0,
        windowEnd: trimmedDuration,
        targetWidth: currentW,
        targetHeight: currentH,
      });
      if (plan) {
        let firstCutoutIdx = -1;
        for (const cutout of plan.inputs) {
          const idx = addFileInput(cutout.name, cutout.data, ["-loop", "1"]);
          if (firstCutoutIdx === -1) firstCutoutIdx = idx;
        }
        const { filters: overlayFilters, outLabel } = plan.buildFilters(firstCutoutIdx, vLabel, newLabel);
        filters.push(...overlayFilters);
        vLabel = outLabel;
      }
    }
  }

  // ---- Speed ----
  if (state.speed !== 1) {
    const out = newLabel("v");
    filters.push(`[${vLabel}]setpts=PTS/${state.speed}[${out}]`);
    vLabel = out;
  }

  // ---- Fade in/out ----
  if (state.fade.in > 0 || state.fade.out > 0) {
    const finalDuration = trimmedDuration / state.speed;
    const parts: string[] = [];
    if (state.fade.in > 0) parts.push(`fade=t=in:st=0:d=${state.fade.in}`);
    if (state.fade.out > 0) {
      const start = Math.max(0, finalDuration - state.fade.out);
      parts.push(`fade=t=out:st=${start.toFixed(2)}:d=${state.fade.out}`);
    }
    const out = newLabel("v");
    filters.push(`[${vLabel}]${parts.join(",")}[${out}]`);
    vLabel = out;
  }

  // ---- Overlays: picture-in-picture, stickers/emoji, GIFs ----
  for (const layer of state.overlays) {
    const isImage = layer.kind === "image";
    const ext = isImage ? guessImageExtension(layer.file) : guessVideoExtension(layer.file);
    const preArgs = isImage ? ["-loop", "1"] : ["-stream_loop", "-1"];
    const idx = addFileInput(`overlay_${layer.id}.${ext}`, layer.file, preArgs);
    const w = evenRound(currentW * (layer.sizePercent / 100));
    const scaled = newLabel("v");
    filters.push(
      `[${idx}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${layer.opacity.toFixed(2)}[${scaled}]`,
    );
    const { x, y } = anchorExpr(layer.anchor);
    const out = newLabel("v");
    const enable = `between(t\\,${layer.start.toFixed(2)}\\,${layer.end.toFixed(2)})`;
    // shortest=1 is essential here: looped image/video overlay inputs are
    // unbounded, and without this the output follows the infinite overlay
    // instead of stopping when the (bounded) main video ends.
    filters.push(`[${vLabel}][${scaled}]overlay=x=${x}:y=${y}:enable='${enable}':shortest=1[${out}]`);
    vLabel = out;
  }

  // ---- Text ----
  let fontBlobEntry: { name: string; data: Blob } | null = null;
  if (state.text.enabled && state.text.content.trim()) {
    const font = getTextFont(state.text.fontId);
    const fontBlob = await fetch(font.url).then((r) => r.blob());
    fontBlobEntry = { name: font.ffmpegName, data: fontBlob };

    const colorHex = state.text.color.replace("#", "0x");
    const { x: xExpr, y: baseY } = positionExprs(state.text.x, state.text.y);
    let yExpr = baseY;
    let alphaExpr = "1";

    if (state.text.animation === "fade") {
      alphaExpr = `min(t/${ANIM_DURATION}\\,1)`;
    } else if (state.text.animation === "slide-up") {
      yExpr = `(${baseY})+((1-min(t/${ANIM_DURATION}\\,1))*${SLIDE_DISTANCE})`;
    } else if (state.text.animation === "slide-down") {
      yExpr = `(${baseY})-((1-min(t/${ANIM_DURATION}\\,1))*${SLIDE_DISTANCE})`;
    }

    const drawtext = [
      `drawtext=fontfile=${font.ffmpegName}`,
      `text='${escapeDrawtext(state.text.content)}'`,
      `fontsize=${state.text.fontSize}`,
      `fontcolor=${colorHex}`,
      `x=${xExpr}`,
      `y=${yExpr}`,
      `alpha='${alphaExpr}'`,
      "box=1:boxcolor=0x000000@0.45:boxborderw=16",
    ].join(":");

    const out = newLabel("v");
    filters.push(`[${vLabel}]${drawtext}[${out}]`);
    vLabel = out;
  }
  if (fontBlobEntry) inputs.push(fontBlobEntry);

  // ---- Audio chain: voice remover -> noise reduction -> speed -> music ----
  let aLabel = `${mainIndex}:a`;
  const audioStageFilters: string[] = [];
  if (state.voiceRemover) audioStageFilters.push(VOICE_REMOVER_FILTER);
  if (state.noise.enabled) audioStageFilters.push(noiseReductionFilter(state.noise.strength));
  if (state.speed !== 1) audioStageFilters.push(atempoChain(state.speed));
  if (audioStageFilters.length > 0) {
    const out = newLabel("a");
    filters.push(`[${aLabel}]${audioStageFilters.join(",")}[${out}]`);
    aLabel = out;
  }

  if (state.music.enabled && state.music.file) {
    const audExt = guessAudioExtension(state.music.file);
    const idx = addFileInput(`music.${audExt}`, state.music.file);
    if (state.music.mode === "replace") {
      aLabel = `${idx}:a`;
    } else {
      const out = newLabel("a");
      filters.push(
        `[${aLabel}][${idx}:a]amix=inputs=2:duration=first:dropout_transition=2[${out}]`,
      );
      aLabel = out;
    }
  }
  const aLabelIsRaw = () => aLabel === `${mainIndex}:a`;

  // ---- Extra clip: concatenate an intro or outro to extend total length ----
  // -map needs bracketed [label] for a filtergraph-generated pad, but the
  // bare form (e.g. "0:v") for a demuxer stream that was never touched by a
  // filter — video and audio are tracked independently since one track can
  // go untouched while the other is filtered (e.g. voice removal only).
  let finalV = vLabel;
  let finalA = aLabel;
  let finalVGenerated = !vLabelIsRaw();
  let finalAGenerated = !aLabelIsRaw();

  if (state.extraClip.enabled && state.extraClip.file) {
    const mainVNorm = newLabel("v");
    filters.push(`[${vLabel}]fps=30,setsar=1[${mainVNorm}]`);
    const mainANorm = newLabel("a");
    filters.push(`[${aLabel}]aformat=sample_rates=44100:channel_layouts=stereo[${mainANorm}]`);

    let extraV: string;
    let extraA: string;
    if (state.extraClip.kind === "image") {
      const imgExt = guessImageExtension(state.extraClip.file);
      const dur = Math.max(0.5, state.extraClip.imageDuration);
      const idx = addFileInput(`extra.${imgExt}`, state.extraClip.file, [
        "-loop",
        "1",
        "-t",
        dur.toFixed(2),
      ]);
      const scaled = newLabel("v");
      filters.push(
        `[${idx}:v]scale=${currentW}:${currentH}:force_original_aspect_ratio=decrease,pad=${currentW}:${currentH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[${scaled}]`,
      );
      extraV = scaled;
      const silentIdx = addLavfiInput(`anullsrc=r=44100:cl=stereo`, ["-t", dur.toFixed(2)]);
      extraA = `${silentIdx}:a`;
    } else {
      const vidExt = guessVideoExtension(state.extraClip.file);
      const idx = addFileInput(`extra.${vidExt}`, state.extraClip.file);
      const scaled = newLabel("v");
      filters.push(
        `[${idx}:v]scale=${currentW}:${currentH}:force_original_aspect_ratio=decrease,pad=${currentW}:${currentH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[${scaled}]`,
      );
      extraV = scaled;
      const aOut = newLabel("a");
      filters.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo[${aOut}]`);
      extraA = aOut;
    }

    const order =
      state.extraClip.position === "before"
        ? [
            { v: extraV, a: extraA },
            { v: mainVNorm, a: mainANorm },
          ]
        : [
            { v: mainVNorm, a: mainANorm },
            { v: extraV, a: extraA },
          ];

    const concatInputs = order.map((s) => `[${s.v}][${s.a}]`).join("");
    const vOut = newLabel("v");
    const aOut = newLabel("a");
    filters.push(`${concatInputs}concat=n=2:v=1:a=1[${vOut}][${aOut}]`);
    finalV = vOut;
    finalA = aOut;
    finalVGenerated = true;
    finalAGenerated = true;
  }

  // ---- Quality / upscale (applied last, after any concat, so it covers the whole output) ----
  const targetSize = resolveQualityTarget(state.quality.target, currentW, currentH);
  if (targetSize) {
    const out = newLabel("v");
    filters.push(`[${finalV}]${upscaleFilter(targetSize.w, targetSize.h, state.quality.sharpen)}[${out}]`);
    finalV = out;
    finalVGenerated = true;
  }

  const args: string[] = [...inputArgs];
  if (filters.length > 0) {
    args.push("-filter_complex", filters.join(";"));
  }
  args.push("-map", finalVGenerated ? `[${finalV}]` : finalV);
  // "?" makes a raw (untouched) audio stream optional, so videos with no
  // audio track (screen recordings, silent clips) still export instead of
  // hard-failing. Once audio has actually been filtered/generated, a missing
  // track surfaces as a clear error instead (nothing to remove voice from).
  args.push("-map", finalAGenerated ? `[${finalA}]` : `${finalA}?`);
  // This build's multithreaded filter execution has a severe contention bug
  // with certain filters (confirmed on colorkey/chromakey — under the
  // default thread pool they never complete in any reasonable time, but run
  // fine single-threaded). The editor's filter graphs are complex and varied
  // enough that pinning everything to one thread is the reliable choice,
  // trading some encode speed for actually finishing.
  args.push("-filter_threads", "1", "-filter_complex_threads", "1");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "1", "-c:a", "aac");
  args.push("output.mp4");

  return { inputs, args, outputName: "output.mp4" };
}
