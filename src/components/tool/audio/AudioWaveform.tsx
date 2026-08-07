import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import { Play, Pause } from "lucide-react";
import { formatTime } from "../../../lib/time";

export interface AudioRegion {
  start: number;
  end: number;
}

/**
 * Self-contained waveform + transport control, built on wavesurfer.js.
 * With `enableRegion`, renders a single draggable/resizable trim region and
 * previews only that region; otherwise it's just a waveform with play/pause.
 */
export default function AudioWaveform({
  url,
  onReady,
  enableRegion = false,
  onRegionChange,
}: {
  url: string;
  onReady?: (duration: number) => void;
  enableRegion?: boolean;
  onRegionChange?: (region: AudioRegion) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const onReadyRef = useRef(onReady);
  const onRegionChangeRef = useRef(onRegionChange);
  onReadyRef.current = onReady;
  onRegionChangeRef.current = onRegionChange;

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const regionsPlugin = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      height: 96,
      waveColor: "rgba(255,255,255,0.35)",
      progressColor: "#a78bfa",
      cursorColor: "#ffffff",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      url,
      plugins: enableRegion ? [regionsPlugin] : [],
    });
    wsRef.current = ws;

    ws.on("ready", (dur) => {
      setDuration(dur);
      onReadyRef.current?.(dur);
      if (enableRegion) {
        const region = regionsPlugin.addRegion({
          start: 0,
          end: dur,
          color: "rgba(167,139,250,0.25)",
          drag: true,
          resize: true,
        });
        regionRef.current = region;
        onRegionChangeRef.current?.({ start: region.start, end: region.end });
      }
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));
    ws.on("timeupdate", (t) => setCurrentTime(t));

    if (enableRegion) {
      regionsPlugin.on("region-updated", (region) => {
        regionRef.current = region;
        onRegionChangeRef.current?.({ start: region.start, end: region.end });
      });
      regionsPlugin.on("region-out", () => ws.pause());
    }

    return () => {
      ws.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enableRegion]);

  const togglePlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (isPlaying) {
      ws.pause();
      return;
    }
    if (enableRegion && regionRef.current) {
      regionRef.current.play();
    } else {
      ws.play();
    }
  };

  return (
    <div className="overflow-hidden rounded-lg bg-neutral-900 p-4">
      <div ref={containerRef} />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <span className="text-caption tabular-nums text-white/70">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
