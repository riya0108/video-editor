import { useEffect, useRef } from "react";
import type { Clip } from "../../../../lib/timeline/clip";
import { isTrimmableContent, clipDurationFrames } from "../../../../lib/timeline/clip";
import { clipGainAt, waveformColumns, type WaveformPeaks } from "../../../../lib/audio/engine-core";

/**
 * Waveform of a clip's trimmed source range, drawn with its gain envelope
 * applied (so fades, volume automation, gain and normalization are visible as
 * the shape of the wave), plus the envelope itself as a line. Pure view: peaks
 * come from the audio source store; the envelope from the same function the
 * mixer uses.
 */
export default function AudioWaveform({ clip, peaks, fps, comp, color = "rgba(255,255,255,0.85)" }: { clip: Clip; peaks: WaveformPeaks; fps: number; comp: { width: number; height: number }; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !isTrimmableContent(clip.content)) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx || !isTrimmableContent(clip.content)) return;
      ctx.clearRect(0, 0, w, h);
      const from = clip.content.sourceInFrame / fps;
      const to = clip.content.sourceOutFrame / fps;
      const cols = waveformColumns(peaks, from, to, w);
      const dur = clipDurationFrames(clip);
      const mid = h / 2;
      ctx.fillStyle = color;
      const gains = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const g = (gains[x] = clipGainAt(clip, ((x + 0.5) / w) * dur, comp));
        const top = Math.max(0, mid - cols.max[x] * g * mid);
        const bot = Math.min(h, mid - cols.min[x] * g * mid);
        ctx.fillRect(x, top, 1, Math.max(1, bot - top));
      }
      // Envelope line: unity gain at the top quarter, so boosts up to +6 dB stay visible.
      ctx.strokeStyle = "rgba(250,204,21,0.95)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = h - Math.min(1, gains[x] / 2) * h * 0.95 - 1;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [clip, peaks, fps, comp, color]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden data-waveform={clip.id} />;
}
