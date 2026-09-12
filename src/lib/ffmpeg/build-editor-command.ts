import {
  guessVideoExtension,
  guessImageExtension,
  guessAudioExtension,
} from "./format";
import { evenRound, evenFloor } from "../geometry";
import { toFfmpegTimestamp } from "../time";
import { escapeDrawtext } from "./drawtext";
import { freeOverlayExprs } from "./overlay-position";
import { getTextFont } from "./fonts";
import { positionExprs } from "./text-position";
import { VOICE_REMOVER_FILTER, noiseReductionFilter, atempoChain } from "./audio-filters";
import { resolveQualityTarget, upscaleFilter } from "./upscale-filter";
import { planCutoutOverlay } from "./person-cutout-filter";
import { appendDelogoWithClone } from "./logo-removal";
import { buildCaptionsFilter, remapCuesToTrim } from "../captions/build-captions-filter";
import { measureKaraokeLayouts } from "../captions/karaoke-layout";
import { parseHexColor } from "../color";
import { buildOverlayAnimationFilters, kenBurnsZoompanFilter } from "./media-animation";
import type { CutoutFrame } from "../captions/person-cutout";
import type { CaptionCue, CaptionStyle } from "../captions/types";
import { resolveBackgroundSize } from "./editor-state";
import type {
  EditorChromaKeyState,
  EditorCropState,
  EditorBackgroundState,
  EditorLogoState,
  EditorMusicState,
  EditorDubState,
  EditorExtraClipState,
  EditorFadeState,
  EditorTextState,
  EditorQualityState,
} from "./editor-state";
import type { OverlayLayer } from "./overlay-layer";

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
  background: EditorBackgroundState;
  speed: number;
  fade: EditorFadeState;
  voiceRemover: boolean;
  noise: { enabled: boolean; strength: number };
  music: EditorMusicState;
  dub: EditorDubState;
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
    // Decoder thread count, not just the encoder's: this build's core-mt
    // wasm can only reliably spin up its *initial* pthread pool — any later
    // on-demand worker request (e.g. from an auto-multithreaded h264 decode)
    // hangs forever in this sandbox with no error. Pinning decode to 1
    // thread per input keeps total pthread demand inside the initial pool.
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
    // x/y clamped to leave room for a minimum 2px box plus a small edge
    // margin, w/h floored against whatever room is left. This build's
    // delogo rejects a box that even just touches the frame edge ("Logo
    // area is outside of the frame" fires for x+w == currentW, not only
    // x+w > currentW), so a region near the frame edge (a natural place for
    // a watermark) must be kept strictly inside it, or it silently produces
    // an empty output.
    const EDGE_MARGIN = 2;
    const x = Math.min(evenRound(state.logo.rect.x * currentW), currentW - EDGE_MARGIN - 2);
    const y = Math.min(evenRound(state.logo.rect.y * currentH), currentH - EDGE_MARGIN - 2);
    const w = evenFloor(Math.min(currentW - EDGE_MARGIN - x, state.logo.rect.w * currentW));
    const h = evenFloor(Math.min(currentH - EDGE_MARGIN - y, state.logo.rect.h * currentH));
    vLabel = appendDelogoWithClone(filters, vLabel, x, y, w, h, [], currentW, currentH, "", () => newLabel("v"));
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

  // ---- Fit onto a target canvas (resize preset / custom size) and fill the
  // empty space: a blurred zoomed copy, a solid color, or a two-color
  // gradient. ----
  if (state.background.enabled) {
    const { w: targetW, h: targetH } = resolveBackgroundSize(state.background);
    const durArg = (trimmedDuration + 1).toFixed(2);

    let bgLabel: string;
    if (state.background.fillMode === "solid") {
      const idx = addLavfiInput(
        `color=c=${state.background.solidColor.replace("#", "0x")}:s=${targetW}x${targetH}:d=${durArg}`,
      );
      bgLabel = `${idx}:v`;
    } else if (state.background.fillMode === "gradient") {
      const from = parseHexColor(state.background.gradientFrom);
      const to = parseHexColor(state.background.gradientTo);
      const t =
        state.background.gradientDirection === "horizontal"
          ? "(X/W)"
          : state.background.gradientDirection === "diagonal"
            ? "((X+Y)/(W+H))"
            : "(Y/H)";
      const expr = (c1: number, c2: number) => `${c1}+(${c2}-${c1})*${t}`;
      const idx = addLavfiInput(`color=c=black:s=${targetW}x${targetH}:d=${durArg}`);
      const gradOut = newLabel("v");
      filters.push(
        `[${idx}:v]geq=r='${expr(from.r, to.r)}':g='${expr(from.g, to.g)}':b='${expr(from.b, to.b)}'[${gradOut}]`,
      );
      bgLabel = gradOut;
    } else {
      const split1 = newLabel("v");
      const split2 = newLabel("v");
      filters.push(`[${vLabel}]split=2[${split1}][${split2}]`);
      const blurOut = newLabel("v");
      filters.push(
        `[${split1}]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},avgblur=sizeX=40:sizeY=40[${blurOut}]`,
      );
      bgLabel = blurOut;
      vLabel = split2;
    }

    const fgOut = newLabel("v");
    filters.push(`[${vLabel}]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[${fgOut}]`);
    const composited = newLabel("v");
    filters.push(`[${bgLabel}][${fgOut}]overlay=(W-w)/2:(H-h)/2[${composited}]`);
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

    let emphasisFontFfmpegName: string | undefined;
    let emphasisFontCssFamily: string | undefined;
    if (state.captions.style.emphasizeKeyword) {
      const emphasisFont = getTextFont(state.captions.style.emphasisFontId);
      emphasisFontFfmpegName = emphasisFont.ffmpegName;
      emphasisFontCssFamily = emphasisFont.cssFontFamily;
      if (emphasisFont.ffmpegName !== font.ffmpegName) {
        const emphasisFontBlob = await fetch(emphasisFont.url).then((r) => r.blob());
        inputs.push({ name: emphasisFont.ffmpegName, data: emphasisFontBlob });
      }
    }

    const remapped = remapCuesToTrim(state.captions.cues, state.trimStart, state.trimEnd);
    const karaokeLayouts = state.captions.style.karaoke
      ? await measureKaraokeLayouts(remapped, state.captions.style, font.cssFontFamily, currentW, emphasisFontCssFamily)
      : undefined;
    const capFilter = buildCaptionsFilter(
      remapped,
      state.captions.style,
      font.ffmpegName,
      karaokeLayouts,
      emphasisFontFfmpegName,
    );
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

    let animatedLabel = scaled;
    if (layer.animation !== "none") {
      const animOut = newLabel("v");
      const animFilters = buildOverlayAnimationFilters(layer.animation, scaled, animOut, layer.start, newLabel);
      filters.push(...animFilters);
      animatedLabel = animOut;
    }

    const { x, y } = freeOverlayExprs(layer.x, layer.y);
    const out = newLabel("v");
    const enable = `between(t\\,${layer.start.toFixed(2)}\\,${layer.end.toFixed(2)})`;
    // shortest=1 is essential here: looped image/video overlay inputs are
    // unbounded, and without this the output follows the infinite overlay
    // instead of stopping when the (bounded) main video ends.
    filters.push(`[${vLabel}][${animatedLabel}]overlay=x=${x}:y=${y}:enable='${enable}':shortest=1[${out}]`);
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
    let finalXExpr = xExpr;
    let yExpr = baseY;
    let alphaExpr = "1";
    const D = ANIM_DURATION;

    switch (state.text.animation) {
      case "fade":
        alphaExpr = `min(t/${D}\\,1)`;
        break;
      case "slide-up":
        yExpr = `(${baseY})+((1-min(t/${D}\\,1))*${SLIDE_DISTANCE})`;
        break;
      case "slide-down":
        yExpr = `(${baseY})-((1-min(t/${D}\\,1))*${SLIDE_DISTANCE})`;
        break;
      case "slide-left":
        finalXExpr = `(${xExpr})+((1-min(t/${D}\\,1))*${SLIDE_DISTANCE})`;
        alphaExpr = `min(t/${D}\\,1)`;
        break;
      case "slide-right":
        finalXExpr = `(${xExpr})-((1-min(t/${D}\\,1))*${SLIDE_DISTANCE})`;
        alphaExpr = `min(t/${D}\\,1)`;
        break;
      case "pop":
        alphaExpr = `min(t/0.2\\,1)`;
        break;
      case "bounce":
        yExpr = `(${baseY})-(20*sin(min(t/${D}\\,1)*PI))`;
        break;
      default:
        break;
    }

    const rawText = state.text.uppercase ? state.text.content.toUpperCase() : state.text.content;
    const drawtextParts = [
      `drawtext=fontfile=${font.ffmpegName}`,
      `text='${escapeDrawtext(rawText)}'`,
      `fontsize=${state.text.fontSize}`,
      `fontcolor=${colorHex}`,
      `x=${finalXExpr}`,
      `y=${yExpr}`,
      `alpha='${alphaExpr}'`,
    ];
    if (state.text.background) {
      const bgOpacity = state.text.backgroundOpacity.toFixed(2);
      drawtextParts.push(`box=1:boxcolor=${state.text.backgroundColor.replace("#", "0x")}@${bgOpacity}:boxborderw=16`);
    }
    if (state.text.outline) {
      drawtextParts.push(`borderw=3:bordercolor=${state.text.outlineColor.replace("#", "0x")}`);
    }
    if (state.text.shadow) {
      drawtextParts.push(`shadowx=3:shadowy=3:shadowcolor=${state.text.shadowColor.replace("#", "0x")}@0.8`);
    }

    const out = newLabel("v");
    filters.push(`[${vLabel}]${drawtextParts.join(":")}[${out}]`);
    vLabel = out;
  }
  if (fontBlobEntry) inputs.push(fontBlobEntry);

  // ---- Audio chain: voice remover -> noise reduction -> speed -> dub -> music ----
  let aLabel = `${mainIndex}:a`;
  // Tracks whether `aLabel` is still a bare demuxer stream reference (e.g.
  // "0:a" or, after a "replace" swap, "1:a") rather than a filtergraph pad —
  // -map needs the bracketed form only for the latter. A same-as-mainIndex
  // check isn't enough here: "replace" modes repoint aLabel at a *different*
  // input's raw stream, which is just as unbracketed as the main one.
  let aIsRaw = true;
  const audioStageFilters: string[] = [];
  if (state.voiceRemover) audioStageFilters.push(VOICE_REMOVER_FILTER);
  if (state.noise.enabled) audioStageFilters.push(noiseReductionFilter(state.noise.strength));
  if (state.speed !== 1) audioStageFilters.push(atempoChain(state.speed));
  if (audioStageFilters.length > 0) {
    const out = newLabel("a");
    filters.push(`[${aLabel}]${audioStageFilters.join(",")}[${out}]`);
    aLabel = out;
    aIsRaw = false;
  }

  // ---- Dub: a replacement/overdub voice track, mixed against the original. ----
  if (state.dub.enabled && state.dub.file) {
    const dubExt = guessAudioExtension(state.dub.file);
    const idx = addFileInput(`dub.${dubExt}`, state.dub.file);
    const dubLabel = `${idx}:a`;
    if (state.dub.mode === "replace") {
      aLabel = dubLabel;
      aIsRaw = true;
    } else if (state.dub.mode === "duck") {
      const duckedOut = newLabel("a");
      filters.push(`[${aLabel}]volume=${state.dub.duckLevel.toFixed(2)}[${duckedOut}]`);
      const mixed = newLabel("a");
      filters.push(`[${duckedOut}][${dubLabel}]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[${mixed}]`);
      aLabel = mixed;
      aIsRaw = false;
    } else {
      const mixed = newLabel("a");
      filters.push(`[${aLabel}][${dubLabel}]amix=inputs=2:duration=first:dropout_transition=2[${mixed}]`);
      aLabel = mixed;
      aIsRaw = false;
    }
  }

  if (state.music.enabled && state.music.file) {
    const audExt = guessAudioExtension(state.music.file);
    const idx = addFileInput(`music.${audExt}`, state.music.file);
    if (state.music.mode === "replace") {
      aLabel = `${idx}:a`;
      aIsRaw = true;
    } else {
      const out = newLabel("a");
      filters.push(
        `[${aLabel}][${idx}:a]amix=inputs=2:duration=first:dropout_transition=2[${out}]`,
      );
      aLabel = out;
      aIsRaw = false;
    }
  }
  const aLabelIsRaw = () => aIsRaw;

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
      const zoompan = kenBurnsZoompanFilter(state.extraClip.animation, currentW, currentH, dur, 30);
      const scaled = newLabel("v");
      const tail = zoompan ? zoompan : "fps=30";
      filters.push(
        `[${idx}:v]scale=${currentW}:${currentH}:force_original_aspect_ratio=decrease,pad=${currentW}:${currentH}:(ow-iw)/2:(oh-ih)/2,setsar=1,${tail}[${scaled}]`,
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
