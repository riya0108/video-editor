/**
 * ffmpeg's `atempo` filter only accepts a factor between 0.5 and 2.0 per
 * instance. To support a wider speed range we chain multiple instances
 * whose product equals the requested speed.
 */
/**
 * Best-effort vocal removal via center-channel (phase) cancellation: audio
 * that's identical (and in-phase) in both stereo channels — usually lead
 * vocals — cancels out when you subtract one channel from the other. Has no
 * effect on mono audio, and works better on some mixes than others; this is
 * the same trick most free "karaoke" tools use, not true source separation.
 */
export const VOICE_REMOVER_FILTER = "pan=stereo|c0=c0-c1|c1=c1-c0";

/** Broadband noise reduction (hiss, hum, fan noise) via ffmpeg's FFT denoiser. */
export function noiseReductionFilter(strengthDb: number): string {
  return `afftdn=nr=${strengthDb}`;
}

export function atempoChain(speed: number): string {
  const clamped = Math.min(100, Math.max(0.02, speed));
  const factors: number[] = [];
  let remaining = clamped;

  while (remaining > 2.0) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);

  return factors.map((f) => `atempo=${f.toFixed(4)}`).join(",");
}
