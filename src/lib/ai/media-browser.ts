import { isTrimmableContent, type Clip } from "../timeline/clip";
import type { FrameRequest } from "../composition/frame-provider";
import type { PcmSource } from "../audio/engine-core";
import type { AIFrame, AIMediaSource } from "./media";
import type { AIServices, TranscriptWord } from "./provider";

/**
 * BROWSER MEDIA ADAPTER (AI_EDITING_ARCHITECTURE.md §6). Builds an AIMediaSource for one clip from the compositor's
 * frame provider (exact decoded frames) and the audio engine's decoded PCM — READ-ONLY: frames are copied into fresh
 * canvases, PCM is sliced into new arrays. Analysis can never write to the original media.
 *
 * Time base: the timeline conforms sources to the project frame rate (TIMELINE_ARCHITECTURE.md §3), so source frame
 * f = source seconds x frameRate, for video and audio alike.
 */

export interface FrameSourceLike {
  getSourceInfo(sourceId: string): { width: number; height: number } | undefined;
  getExactFrame(req: FrameRequest): Promise<CanvasImageSource>;
}

export function createClipMediaSource(clip: Clip, frameRate: number, frames: FrameSourceLike, pcm: (sourceId: string) => PcmSource | undefined): AIMediaSource {
  const c = clip.content;
  const sourceId = (c as { source?: { sourceId: string } }).source?.sourceId;
  if (!sourceId) throw new Error("This layer has no source media to analyse.");
  const info = frames.getSourceInfo(sourceId);
  const trimmable = isTrimmableContent(c);
  const sourceStart = trimmable ? c.sourceInFrame / frameRate : 0;
  const sourceEnd = trimmable ? c.sourceOutFrame / frameRate : (c as { durationFrames: number }).durationFrames / frameRate;
  const audio = pcm(sourceId);
  const still = !trimmable;
  let canvas: HTMLCanvasElement | null = null;
  return {
    sourceStart,
    sourceEnd,
    fps: frameRate,
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    hasVideo: !!info && c.kind !== "audio",
    hasAudio: !!audio && audio.channels.length > 0 && audio.channels[0].length > 0,
    still,
    async frameAt(t: number, maxSide: number): Promise<AIFrame> {
      if (!info) throw new Error("The clip's picture isn't loaded.");
      const sourceFrame = still ? 0 : Math.max(0, Math.round(t * frameRate - 0.5));
      const img = await frames.getExactFrame({ sourceId, sourceFrame, slotKey: `${clip.id}#ai` });
      const k = Math.min(1, maxSide / Math.max(info.width, info.height));
      const w = Math.max(1, Math.round(info.width * k));
      const h = Math.max(1, Math.round(info.height * k));
      canvas ??= document.createElement("canvas");
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, data: d.data };
    },
    async audio() {
      if (!audio) throw new Error("The clip's audio isn't decoded.");
      const i0 = Math.max(0, Math.floor(sourceStart * audio.sampleRate));
      const i1 = Math.min(audio.channels[0].length, Math.ceil(sourceEnd * audio.sampleRate));
      return { sampleRate: audio.sampleRate, channels: audio.channels.map((ch) => ch.slice(i0, Math.max(i0, i1))) };
    },
  };
}

/** The app's AI services: Whisper speech-to-text and image registration into the compositor. */
export function createBrowserServices(opts: { registerCanvas: (id: string, canvas: HTMLCanvasElement) => void; whisperTier?: "fast" | "balanced" }): AIServices {
  return {
    async transcribe(pcm16k, onProgress): Promise<TranscriptWord[]> {
      const { transcribeAudio16k } = await import("../captions/auto-caption");
      const r = await transcribeAudio16k(pcm16k, { modelTier: opts.whisperTier ?? "fast", onProgress: (p) => onProgress?.(p.phase === "downloading" ? p.fraction * 0.3 : 0.3 + p.fraction * 0.7) });
      return r.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    },
    registerImage(id, rgba, width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      opts.registerCanvas(id, canvas);
      return id;
    },
  };
}
