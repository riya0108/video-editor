import type { SourceInfo } from "./resolve";

/**
 * Where pixels come from. The compositor never touches File/Blob/URL/<video>
 * itself — it asks a FrameProvider, keyed by the timeline's opaque
 * MediaSourceRef.sourceId. A background-removal matte is just another source
 * (an image or frame sequence whose alpha channel is the matte), so mattes
 * need no special path here.
 *
 * Two deliberately different access methods, one per render path:
 *  - peekFrame: preview. Synchronous, never waits. Returns whatever is
 *    decoded right now (may be a frame or two off while seeking) or null.
 *  - getExactFrame: final. Async, resolves only with the exact requested
 *    frame at full source resolution, or rejects.
 */
export interface FrameRequest {
  sourceId: string;
  /** Frame index into the source, in project frames. Ignored for still sources. */
  sourceFrame: number;
  /**
   * Which on-screen layer is asking (its clip id). Lets a provider back two
   * simultaneous uses of the same source at different times (e.g. the same
   * video on two tracks, offset) with separate decoders.
   */
  slotKey: string;
}

export interface FrameProvider {
  getSourceInfo(sourceId: string): SourceInfo | undefined;
  peekFrame(request: FrameRequest): CanvasImageSource | null;
  getExactFrame(request: FrameRequest): Promise<CanvasImageSource>;
  /** Preview only: called before/after each preview frame's peeks so a provider can park decoders that are no longer on screen. */
  beginPreviewFrame?(): void;
  endPreviewFrame?(): void;
}

/** Pixel size of anything drawImage() accepts — the frame handed back may be a proxy at a different size than SourceInfo, and the renderer maps crop rects through the real size. */
export function imageSourceSize(src: CanvasImageSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) return { width: src.videoWidth, height: src.videoHeight };
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) return { width: src.naturalWidth, height: src.naturalHeight };
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) return { width: src.displayWidth, height: src.displayHeight };
  if (typeof SVGImageElement !== "undefined" && src instanceof SVGImageElement) return { width: src.width.baseVal.value, height: src.height.baseVal.value };
  const sized = src as { width: number; height: number };
  return { width: sized.width, height: sized.height };
}
