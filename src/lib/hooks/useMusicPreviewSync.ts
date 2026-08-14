import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Live preview for "Add music": a hidden <audio> element kept in sync with
 * the main video's play state and position (trim-relative), muting the
 * video's own audio when replacing it. Deliberately outside the Web Audio
 * graph used for voice-remover/noise reduction — mixing two independently
 * playing elements sounds the same regardless of processing order, so this
 * stays simple rather than routing the music file through that graph too.
 */
export function useMusicPreviewSync({
  videoRef,
  enabled,
  file,
  mode,
  start,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  file: File | null;
  mode: "mix" | "replace";
  start: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setSourceUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = enabled && mode === "replace";
  }, [enabled, mode, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || !enabled || !sourceUrl) return;

    const sync = () => {
      const target = Math.max(0, video.currentTime - start);
      if (Math.abs(audio.currentTime - target) > 0.3) audio.currentTime = target;
    };
    const onPlay = () => {
      sync();
      audio.play().catch(() => {});
    };
    const onPause = () => audio.pause();

    sync();
    if (!video.paused) audio.play().catch(() => {});

    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeked", sync);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      audio.pause();
    };
  }, [enabled, sourceUrl, start, videoRef]);

  return { audioRef, sourceUrl };
}
