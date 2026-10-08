import {
  ALL_FORMATS,
  AudioBufferSink,
  EncodedAudioPacketSource,
  EncodedPacket,
  BlobSource,
  BufferTarget,
  CanvasSink,
  EncodedPacketSink,
  Input,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  VideoSample,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type InputAudioTrack,
  type VideoCodec,
} from "mediabunny";
import type { TimelineModel } from "../timeline/model";
import type { PcmSource } from "../audio/engine-core";
import type { FrameProvider } from "../composition/frame-provider";
import type { TextMeasurer } from "../composition/text-layout";
import { FinalRenderer } from "../composition/final-renderer";
import { buildRenderPlan, frameStep, RenderPlanError, type RenderPlan } from "./plan";
import { audioBlockers, audioChunks, renderAudio, type AudioSourceState, type RenderedAudio } from "./audio";
import { crossCheckFrame, type CrossCheckIssue } from "./graph";
import { alphaCheck, alphaPsnr, audioSyncCheck, fidelityCheck, flattenOverBlack, measureLag, psnr, structureCheck, technicalChecks, type ProbedOutput, type RenderCheck, type RenderReport } from "./validate";
import { codecLabel, type OutputContainer, type OutputVideoCodec, type RenderSettings } from "./settings";

/**
 * FINAL RENDER JOB (RENDER_ENGINE_ARCHITECTURE.md §5–§8) — browser only.
 *
 *   plan -> for every output frame: FinalRenderer (exact source frames, full quality) -> structural cross-check
 *        -> VideoEncoder (WebCodecs, via Mediabunny) ; audio: offline mix -> AudioEncoder ; -> MP4 mux
 *        -> read the file back -> validate (format, frames, timing, audio, pixels) -> report
 *
 * Nothing here shares state with the preview: its own FinalRenderer (own canvas + scratch), the provider's dedicated
 * exact-frame decoders, frames in strict order. A failure anywhere is an error with the frame it happened on — an
 * export never "succeeds" with a missing layer, a dropped frame or a short audio track.
 */

export interface RenderDeps {
  provider: FrameProvider;
  measurer: TextMeasurer;
  pcm: (sourceId: string) => PcmSource | undefined;
  audioState: (sourceId: string) => AudioSourceState;
}

export interface RenderProgress {
  phase: "preparing" | "video" | "audio" | "finalizing" | "validating";
  done: number;
  total: number;
}

export interface RenderOutcome {
  blob: Blob;
  plan: RenderPlan;
  report: RenderReport;
}

/** Longer side of the frames compared after encoding (both sides downscaled identically). */
const COMPARE_SIDE = 480;

export async function renderTimeline(timeline: TimelineModel, settings: RenderSettings, deps: RenderDeps, opts: { signal?: AbortSignal; onProgress?: (p: RenderProgress) => void } = {}): Promise<RenderOutcome> {
  const t0 = performance.now();
  const progress = (phase: RenderProgress["phase"], done: number, total: number) => opts.onProgress?.({ phase, done, total });
  const abortIfNeeded = () => {
    if (opts.signal?.aborted) throw new DOMException("Render cancelled.", "AbortError");
  };
  progress("preparing", 0, 1);
  const plan = buildRenderPlan(timeline, settings);
  const s = plan.settings;
  const blockers = s.audio ? audioBlockers(timeline, plan, deps.audioState) : [];
  if (blockers.length) throw new RenderPlanError(blockers);

  const warnings: string[] = [];
  const encodeOpts = { width: s.width, height: s.height, bitrate: s.videoBitrate };
  let videoCodec: VideoCodec | null;
  if (s.videoCodec) {
    // An explicit choice is honoured exactly or refused — never silently swapped.
    videoCodec = (await canEncodeVideoWith(s.videoCodec, encodeOpts, s.alpha)) ? s.videoCodec : null;
    if (!videoCodec) throw new RenderPlanError([`This browser can't encode ${codecLabel(s.videoCodec)}${s.alpha ? " with alpha" : ""} at ${s.width}×${s.height}, ${(s.videoBitrate / 1e6).toFixed(1)} Mbit/s. Pick another codec or size.`]);
  } else {
    videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"] as VideoCodec[], encodeOpts);
    if (!videoCodec) throw new RenderPlanError([`This browser can't encode ${s.width}×${s.height} video at ${(s.videoBitrate / 1e6).toFixed(1)} Mbit/s with any supported codec.`]);
    if (videoCodec !== "avc") warnings.push(`H.264 isn't available here at ${s.width}×${s.height}; encoded as ${videoCodec.toUpperCase()} instead.`);
  }
  let audioCodec: AudioCodec | null = null;
  if (s.audio) {
    const fmt = { numberOfChannels: s.audio.channels, sampleRate: s.audio.sampleRate, bitrate: s.audio.bitrate };
    if (!(await canEncodeAudio(s.audio.codec, fmt))) throw new RenderPlanError([`This browser can't encode ${codecLabel(s.audio.codec)} audio at ${s.audio.bitrate / 1000} kbit/s. Pick another audio codec or bitrate.`]);
    // Preflight: actually encode with this exact configuration (it's the cached delay measurement the audio stage needs
    // anyway). Capability queries can lie — Chrome's macOS AAC encoder "supports" 384 kbit/s and then fails every
    // encode — and finding that out after rendering every video frame would waste the whole render.
    try {
      await encoderDelaySamples(s.audio.codec, { sampleRate: s.audio.sampleRate, channels: s.audio.channels, bitrate: s.audio.bitrate });
    } catch (e) {
      throw new RenderPlanError([`This browser's ${codecLabel(s.audio.codec)} encoder fails at ${s.audio.bitrate / 1000} kbit/s although it reports support (${(e as Error).message}). Pick a lower audio bitrate.`]);
    }
    audioCodec = s.audio.codec;
  }
  const transparentBg = timeline.composition.background === "transparent";
  if (transparentBg && !s.alpha) warnings.push(`The composition background is transparent; ${s.container.toUpperCase()} + ${codecLabel(videoCodec as OutputVideoCodec)} has no alpha channel, so it is rendered over black.`);
  if (s.alpha && !transparentBg) warnings.push("Alpha was requested, but the composition background is opaque: every pixel will be fully opaque.");
  const P = plan.placement;
  const framed = P.x !== 0 || P.y !== 0 || P.width !== s.width || P.height !== s.height;
  if (framed) warnings.push(s.framing === "fit" ? `Letterboxed: the ${timeline.composition.width}×${timeline.composition.height} composition is scaled to ${P.width}×${P.height} and centred in ${s.width}×${s.height}, with ${s.alpha ? "transparent" : "black"} bars.` : `Cropped: the ${timeline.composition.width}×${timeline.composition.height} composition is scaled to ${P.width}×${P.height} to cover ${s.width}×${s.height}; ${Math.max(-P.x, 0) * 2 || Math.max(-P.y, 0) * 2} px are cut off ${P.x < 0 ? "left and right" : "top and bottom"}.`);

  const output = new Output({ format: outputFormat(s.container), target: new BufferTarget() });
  const videoSource = new VideoSampleSource({ codec: videoCodec, bitrate: s.videoBitrate, bitrateMode: s.bitrateMode, keyFrameInterval: s.keyframeIntervalSec, latencyMode: "quality", alpha: s.alpha ? "keep" : "discard" });
  output.addVideoTrack(videoSource, { frameRate: s.fps });
  const audioSource = audioCodec && s.audio ? new EncodedAudioPacketSource(audioCodec) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const renderer = new FinalRenderer(deps.provider, deps.measurer);
  // Framing: the composition is rendered at the placement's scale and copied 1:1 (integer offset, no resampling) into the output frame.
  const frameCanvas = framed ? new OffscreenCanvas(s.width, s.height) : null;
  const frameCtx = frameCanvas?.getContext("2d", { alpha: s.alpha }) ?? null;
  const checkpoints = new Set(plan.checkpoints);
  const references = new Map<number, Uint8ClampedArray>();
  const structural: { frame: number; issues: CrossCheckIssue[] }[] = [];
  const resolveCtx = { getSourceInfo: (id: string) => deps.provider.getSourceInfo(id), measurer: deps.measurer };
  let compareSize: { width: number; height: number } | null = null;
  let mixed: RenderedAudio | null = null;

  try {
    for (let k = 0; k < plan.frameCount; k++) {
      abortIfNeeded();
      const step = frameStep(plan, k);
      const rendered = await renderer.renderFrame(timeline, step.timelineFrame, { outputScale: plan.renderScale, mediaFrameOffset: plan.mediaFrameOffset });
      if (rendered.canvas.width !== P.width || rendered.canvas.height !== P.height) throw new Error(`Frame ${k} rendered at ${rendered.canvas.width}×${rendered.canvas.height}, expected ${P.width}×${P.height}.`);
      let canvas: CanvasImageSource & { width: number; height: number } = rendered.canvas as CanvasImageSource & { width: number; height: number };
      if (frameCanvas && frameCtx) {
        frameCtx.globalCompositeOperation = "copy";
        frameCtx.fillStyle = s.alpha ? "rgba(0,0,0,0)" : "#000";
        frameCtx.fillRect(0, 0, s.width, s.height);
        frameCtx.globalCompositeOperation = "source-over";
        frameCtx.drawImage(canvas, P.x, P.y);
        canvas = frameCanvas;
      }
      const issues = crossCheckFrame(timeline, step.timelineFrame, rendered.resolved, resolveCtx);
      if (issues.length) structural.push({ frame: k, issues });
      if (checkpoints.has(k)) {
        const thumb = downscale(canvas);
        compareSize = thumb.size;
        references.set(k, s.alpha ? thumb.rgba : flattenOverBlack(thumb.rgba));
      }
      const sample = new VideoSample(canvas, { timestamp: step.timestamp, duration: step.duration });
      try {
        await videoSource.add(sample);
      } finally {
        sample.close();
      }
      progress("video", k + 1, plan.frameCount);
    }
    if (audioSource) {
      abortIfNeeded();
      progress("audio", 0, 1);
      const audio = renderAudio(timeline, deps.pcm, plan);
      mixed = audio;
      if (audio.clippedSamples > 0) warnings.push(`The audio mix peaks at ${(20 * Math.log10(audio.peak)).toFixed(1)} dBFS: ${audio.clippedSamples} samples were clipped at full scale. Lower the volume of loud clips.`);
      await encodeAudioExact(audio, audioCodec!, s.audio!, plan.durationSec, audioSource, s.container);
      progress("audio", 1, 1);
    }
    abortIfNeeded();
    progress("finalizing", 0, 1);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }

  const buffer = (output.target as BufferTarget).buffer;
  const blob = new Blob(buffer ? [buffer] : [], { type: await output.getMimeType() });
  const renderMs = performance.now() - t0;

  // ---- validation: read the FILE back, never trust the encoder's own bookkeeping ----
  abortIfNeeded();
  progress("validating", 0, 1);
  const checks: RenderCheck[] = [];
  const fileCheck = (ok: boolean, detail: string) => checks.push({ id: "file", label: "File written and readable", ok, detail });
  if (blob.size === 0) {
    fileCheck(false, "The encoder returned without error but produced an empty file.");
    return { blob, plan, report: { ok: false, checks, warnings, codec: [videoCodec, audioCodec].filter(Boolean).join(" + "), bytes: 0, renderMs, frameCount: plan.frameCount, durationSec: plan.durationSec } };
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    let probed: ProbedOutput;
    try {
      probed = await probeInput(input, blob.type);
    } catch (e) {
      fileCheck(false, `${blob.size.toLocaleString("en-US")} bytes, but the file can't be read back: ${(e as Error).message}`);
      return { blob, plan, report: { ok: false, checks, warnings, codec: [videoCodec, audioCodec].filter(Boolean).join(" + "), bytes: blob.size, renderMs, frameCount: plan.frameCount, durationSec: plan.durationSec } };
    }
    fileCheck(true, `${blob.size.toLocaleString("en-US")} bytes, ${probed.container ?? "unknown container"} (${probed.mimeType})`);
    // Audio is decoded once up front: its duration is judged by what a player actually outputs, not container metadata.
    const audioTrack = await input.getPrimaryAudioTrack();
    let decodedAudio: { samples: Float32Array; endSec: number } | null = null;
    if (audioTrack && mixed) {
      try {
        decodedAudio = await decodeChannel0(audioTrack, mixed.sampleRate, mixed.channels[0].length);
      } catch (e) {
        checks.push({ id: "audio-decode", label: "Audio decodes", ok: false, detail: `The audio track can't be decoded: ${(e as Error).message}` });
      }
    }
    if (decodedAudio && probed.audio) probed.audio.decodedSec = decodedAudio.endSec;
    checks.push(...technicalChecks(plan, probed, { video: videoCodec, audio: audioCodec }));
    checks.push(structureCheck(structural, plan.frameCount));
    const videoTrack = await input.getPrimaryVideoTrack();
    const fidelity: { frame: number; psnr: number }[] = [];
    const alphaFidelity: { frame: number; psnr: number }[] = [];
    let decodeFailure: { frame: number; message: string } | null = null;
    if (videoTrack && compareSize) {
      const sink = new CanvasSink(videoTrack, { poolSize: 1, alpha: s.alpha });
      for (const k of plan.checkpoints) {
        abortIfNeeded();
        const ref = references.get(k);
        if (!ref) continue;
        // Mid-frame timestamp: unambiguously inside frame k whatever the container's timestamp rounding.
        let wrapped: Awaited<ReturnType<typeof sink.getCanvas>>;
        try {
          wrapped = await sink.getCanvas((k + 0.5) / s.fps);
        } catch (e) {
          // A broken bitstream is a failed check on a kept file, not an exception that loses the report.
          decodeFailure = { frame: k, message: (e as Error).message };
          break;
        }
        if (!wrapped) {
          fidelity.push({ frame: k, psnr: 0 });
          if (s.alpha) alphaFidelity.push({ frame: k, psnr: 0 });
          continue;
        }
        const got = downscale(wrapped.canvas as CanvasImageSource & { width: number; height: number }).rgba;
        if (s.alpha) {
          alphaFidelity.push({ frame: k, psnr: alphaPsnr(ref, got) });
          fidelity.push({ frame: k, psnr: psnr(flattenOverBlack(ref.slice()), flattenOverBlack(got)) });
        } else fidelity.push({ frame: k, psnr: psnr(ref, got) });
      }
    }
    if (decodeFailure) checks.push({ id: "video-decode", label: "Video decodes", ok: false, detail: `The video can't be decoded at frame ${decodeFailure.frame}: ${decodeFailure.message}` });
    checks.push(fidelityCheck(fidelity, undefined, references.size));
    if (s.alpha) checks.push(alphaCheck(probed, alphaFidelity));
    if (decodedAudio && mixed) checks.push(audioSyncCheck(measureLag(mixed.channels[0], decodedAudio.samples, mixed.sampleRate), mixed.sampleRate));
    const report: RenderReport = {
      ok: checks.every((c) => c.ok),
      checks,
      warnings,
      codec: [videoCodec, audioCodec].filter(Boolean).join(" + "),
      bytes: blob.size,
      renderMs,
      frameCount: plan.frameCount,
      durationSec: plan.durationSec,
    };
    progress("validating", 1, 1);
    return { blob, plan, report };
  } finally {
    input.dispose();
  }
}

function outputFormat(container: OutputContainer) {
  if (container === "webm") return new WebMOutputFormat();
  if (container === "mov") return new MovOutputFormat({ fastStart: "in-memory" });
  return new Mp4OutputFormat({ fastStart: "in-memory" });
}

/** Mediabunny's encodability check, plus WebCodecs' own answer for alpha (Mediabunny encodes VP9/VP8 alpha as a second stream when the browser can't). */
async function canEncodeVideoWith(codec: OutputVideoCodec, o: { width: number; height: number; bitrate: number }, alpha: boolean): Promise<boolean> {
  if (!(await canEncodeVideo(codec, o))) return false;
  return !alpha || codec === "vp9" || codec === "vp8";
}

/** Reads what the encoded file actually contains. */
export async function probeInput(input: Input, mimeType: string): Promise<ProbedOutput> {
  const format = await input.getFormat();
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  let video: ProbedOutput["video"] = null;
  if (v) {
    const timestamps: number[] = [];
    let bytes = 0;
    const sink = new EncodedPacketSink(v);
    for (let p = await sink.getFirstPacket({ metadataOnly: true }); p; p = await sink.getNextPacket(p, { metadataOnly: true })) {
      timestamps.push(p.timestamp);
      bytes += p.byteLength;
    }
    timestamps.sort((x, y) => x - y);
    video = { codec: await v.getCodec(), width: await v.getDisplayWidth(), height: await v.getDisplayHeight(), frameCount: timestamps.length, timestamps, durationSec: await v.computeDuration(), bytes, canBeTransparent: await v.canBeTransparent() };
  }
  let audio: ProbedOutput["audio"] = null;
  if (a) {
    let bytes = 0;
    const sink = new EncodedPacketSink(a);
    for (let p = await sink.getFirstPacket({ metadataOnly: true }); p; p = await sink.getNextPacket(p, { metadataOnly: true })) bytes += p.byteLength;
    audio = { codec: await a.getCodec(), sampleRate: await a.getSampleRate(), channels: await a.getNumberOfChannels(), durationSec: await a.computeDuration(), bytes };
  }
  return { mimeType, container: format.name, containerMime: format.mimeType, video, audio };
}

/** Identical downscale for the reference and the decoded frame (same canvas path, same filter). */
function downscale(src: CanvasImageSource & { width: number; height: number }): { rgba: Uint8ClampedArray; size: { width: number; height: number } } {
  const k = Math.min(1, COMPARE_SIDE / Math.max(src.width, src.height));
  const width = Math.max(1, Math.round(src.width * k));
  const height = Math.max(1, Math.round(src.height * k));
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, width, height);
  return { rgba: g.getImageData(0, 0, width, height).data, size: { width, height } };
}

/**
 * AUDIO ENCODE, sample-exact (§6). The track must start AND end with the video:
 *  - start: AAC encoders prepend priming samples (2112 on macOS) that decoders output as-is. The measured delay is
 *    subtracted from every packet timestamp, so the track starts before zero and the muxer writes an edit list that
 *    trims the priming — the first audible sample plays at t = 0 (live test: uncompensated audio was 44 ms late);
 *  - end: the encoder pads its last frame and may flush an extra one. Packets lying wholly past the video's end are
 *    dropped and the last one's duration is cut to end exactly at `durationSec` (live test: the track ran 31 ms long).
 * The encoder is driven directly (WebCodecs) because both need control over packet timestamps and durations.
 */
async function encodeAudioExact(audio: RenderedAudio, codec: AudioCodec, a: { channels: number; bitrate: number }, durationSec: number, sink: EncodedAudioPacketSource, container: OutputContainer): Promise<void> {
  const sr = audio.sampleRate;
  const shift = (await encoderDelaySamples(codec, { sampleRate: sr, channels: a.channels, bitrate: a.bitrate })) / sr;
  const chunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
  let failure: unknown = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => chunks.push({ chunk, meta }), error: (e) => (failure = e) });
  enc.configure({ codec: webCodecsAudioCodec(codec), sampleRate: sr, numberOfChannels: 2, bitrate: a.bitrate });
  for (const c of audioChunks(audio)) {
    enc.encode(new AudioData({ format: "f32-planar", sampleRate: sr, numberOfChannels: 2, numberOfFrames: c.frames, timestamp: Math.round(c.timestamp * 1e6), data: c.data as Float32Array<ArrayBuffer> }));
    if (enc.encodeQueueSize > 32) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  // Delay the DECODER removes by itself, signalled in the codec header (Opus pre-skip): packet time runs that much
  // ahead of presentation time, so the end is cut in presentation time (live test: cutting in packet time dropped the
  // last Opus packet and the track came out 20 ms short).
  const signalled = codecDelaySec(codec, chunks.find((c) => c.meta?.decoderConfig)?.meta?.decoderConfig);
  // MP4/MOV trim the last packet through the edit list; Mediabunny's WebM writes no DiscardPadding, so there the last
  // packet stays whole (its tail past the video is encoder padding = silence, under one frame).
  const canTrimEnd = container !== "webm";
  let t = chunks.length ? chunks[0].chunk.timestamp / 1e6 - shift : 0;
  for (let i = 0; i < chunks.length; i++) {
    const { chunk, meta } = chunks[i];
    const dur = (chunk.duration ?? 0) / 1e6;
    if (t - signalled >= durationSec - 1e-9) break;
    const packet = EncodedPacket.fromEncodedChunk(chunk).clone({ timestamp: t, duration: canTrimEnd ? Math.min(dur, durationSec + signalled - t) : dur });
    await sink.add(packet, i === 0 ? meta : undefined);
    t += dur;
  }
}

/** Seconds of priming the codec header tells every decoder to drop (Opus: OpusHead pre-skip at 48 kHz). AAC signals none in WebCodecs. */
export function codecDelaySec(codec: AudioCodec, config: AudioDecoderConfig | undefined): number {
  if (codec !== "opus" || !config?.description) return 0;
  const d = config.description;
  const bytes = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  // OpusHead: "OpusHead" (8) | version (1) | channels (1) | pre-skip (u16 LE) ...
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== "OpusHead") return 0;
  return (bytes[10] | (bytes[11] << 8)) / 48000;
}

function webCodecsAudioCodec(codec: AudioCodec): string {
  return codec === "aac" ? "mp4a.40.2" : codec;
}

/** Decodes a track's first channel onto a sample grid at its presentation timestamps (edit list / pre-skip applied by the demuxer and decoder). `endSec` = where the decoded audio actually ends. */
async function decodeChannel0(track: InputAudioTrack, sampleRate: number, length: number): Promise<{ samples: Float32Array; endSec: number }> {
  const out = new Float32Array(length);
  let end = 0;
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
    if (buffer.sampleRate !== sampleRate) throw new Error(`Decoded audio is ${buffer.sampleRate} Hz, expected ${sampleRate} Hz.`);
    const ch = buffer.getChannelData(0);
    const at = Math.round(timestamp * sampleRate);
    end = Math.max(end, at + ch.length);
    for (let i = Math.max(0, -at); i < ch.length && at + i < length; i++) out[at + i] = ch[i];
  }
  return { samples: out, endSec: end / sampleRate };
}

const delayCache = new Map<string, Promise<number>>();

/**
 * Samples of priming an encoder configuration adds, MEASURED: a seeded noise burst at a known position is encoded and
 * decoded with WebCodecs, and the burst is located by cross-correlation. Cached per configuration.
 */
export function encoderDelaySamples(codec: AudioCodec, a: { sampleRate: number; channels: number; bitrate: number }): Promise<number> {
  const key = `${codec}/${a.sampleRate}/${a.channels}/${a.bitrate}`;
  let p = delayCache.get(key);
  if (!p) {
    p = measureEncoderDelay(codec, a).catch((e) => {
      delayCache.delete(key);
      throw e;
    });
    delayCache.set(key, p);
  }
  return p;
}

async function measureEncoderDelay(codec: AudioCodec, a: { sampleRate: number; channels: number; bitrate: number }): Promise<number> {
  const sr = a.sampleRate;
  const n = sr; // 1 s
  const at = Math.round(sr * 0.3);
  const ref = new Float32Array(n);
  let seed = 12345;
  for (let i = at; i < at + Math.round(sr * 0.05); i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    ref[i] = (seed / 0x7fffffff - 0.5) * 1.2;
  }
  const webCodec = webCodecsAudioCodec(codec);
  const chunks: EncodedAudioChunk[] = [];
  let decoderConfig: AudioDecoderConfig | undefined;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => {
      throw e;
    },
  });
  enc.configure({ codec: webCodec, sampleRate: sr, numberOfChannels: a.channels, bitrate: a.bitrate });
  const planar = new Float32Array(n * a.channels);
  for (let c = 0; c < a.channels; c++) planar.set(ref, c * n);
  enc.encode(new AudioData({ format: "f32-planar", sampleRate: sr, numberOfChannels: a.channels, numberOfFrames: n, timestamp: 0, data: planar }));
  await enc.flush();
  enc.close();
  if (!decoderConfig) throw new Error("The audio encoder gave no decoder configuration.");
  const decoded: Float32Array[] = [];
  const dec = new AudioDecoder({
    output: (d) => {
      const f = new Float32Array(d.numberOfFrames);
      d.copyTo(f, { planeIndex: 0, format: "f32-planar" });
      decoded.push(f);
      d.close();
    },
    error: (e) => {
      throw e;
    },
  });
  dec.configure(decoderConfig);
  for (const c of chunks) dec.decode(c);
  await dec.flush();
  dec.close();
  const all = new Float32Array(decoded.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const d of decoded) {
    all.set(d, o);
    o += d.length;
  }
  const m = measureLag(ref, all, sr, 8192, 0.1);
  if (m.silent || m.corr < 0.8) throw new Error(`Couldn't measure the audio encoder's delay (correlation ${m.corr.toFixed(2)}).`);
  return Math.max(0, m.lag);
}
