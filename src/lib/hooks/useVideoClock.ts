import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks a video element's playback position at animation-frame granularity
 * instead of relying on the native `timeupdate` event, which browsers throttle
 * to only a few callbacks per second — too coarse for anything keyed to
 * short word-level windows (karaoke highlighting, per-word caption fades),
 * where it makes those windows look like they pop/lag instead of tracking
 * speech smoothly. Polls `videoRef.current` fresh every frame rather than
 * attaching listeners to it, so it keeps working across the element being
 * (re)mounted without needing to re-run the effect.
 */
export function useVideoClock(videoRef: RefObject<HTMLVideoElement | null>): number {
  const [time, setTime] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      if (video) setTime(video.currentTime);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [videoRef]);

  return time;
}
