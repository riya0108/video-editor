import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { buildVoiceRemoverNodes } from "../media/voice-remover-graph";

/**
 * Live preview for voice remover (exact match to the ffmpeg filter) and
 * noise reduction (an approximation — ffmpeg's `afftdn` is a full spectral
 * denoiser, not practical to replicate exactly in real time; this uses a
 * highpass + gentle compressor instead, strength-mapped, just to give an
 * audible sense of "less noisy" rather than a scientifically accurate one).
 *
 * Only touches the video element's audio routing (via
 * `createMediaElementSource`, which is a one-way door — once called, that
 * element's audio only plays through whatever this graph connects to
 * `ctx.destination`) the first time either effect is actually enabled, so
 * users who never open these two panels get zero Web Audio involvement and
 * zero risk of a botched `AudioContext.resume()` silencing playback.
 */
export function useVoiceNoiseAudioGraph({
  videoRef,
  voiceRemover,
  noiseEnabled,
  noiseStrength,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  voiceRemover: boolean;
  noiseEnabled: boolean;
  noiseStrength: number;
}) {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!voiceRemover && !noiseEnabled && !sourceRef.current) return;

    if (!ctxRef.current) {
      const AudioContextCtor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new AudioContextCtor();
    }
    const ctx = ctxRef.current;
    if (!sourceRef.current) {
      sourceRef.current = ctx.createMediaElementSource(el);
    }
    const source = sourceRef.current;

    source.disconnect();
    let node: AudioNode = source;
    if (voiceRemover) {
      const { input, output } = buildVoiceRemoverNodes(ctx);
      node.connect(input);
      node = output;
    }
    if (noiseEnabled) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 80 + noiseStrength * 4;
      highpass.Q.value = 0.7;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -36;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      node.connect(highpass);
      highpass.connect(compressor);
      node = compressor;
    }
    node.connect(ctx.destination);
  }, [voiceRemover, noiseEnabled, noiseStrength, videoRef]);

  useEffect(() => {
    return () => {
      sourceRef.current?.disconnect();
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return {
    /** Call from the same user gesture that starts playback — AudioContexts start suspended until resumed by one. */
    resume: () => {
      ctxRef.current?.resume().catch(() => {});
    },
  };
}
