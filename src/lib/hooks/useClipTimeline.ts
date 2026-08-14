import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { EditorExtraClipState } from "../ffmpeg/editor-state";

export type ClipSegmentKind = "main" | "extra";

export interface ClipTimeline {
  /** False (with every other field inert) when there's no enabled extra clip — callers should fall back to their normal main-video-only playback logic entirely. */
  active: boolean;
  totalDuration: number;
  introOffset: number;
  virtualTime: number;
  isPlaying: boolean;
  activeSegmentKind: ClipSegmentKind;
  togglePlay: () => void;
  seekTo: (virtualTime: number) => void;
}

const INACTIVE: ClipTimeline = {
  active: false,
  totalDuration: 0,
  introOffset: 0,
  virtualTime: 0,
  isPlaying: false,
  activeSegmentKind: "main",
  togglePlay: () => {},
  seekTo: () => {},
};

/**
 * Virtual-timeline state machine for the intro/outro "Clips" panel: makes
 * scrubbing or playing across [extra][main] / [main][extra] switch the
 * visible/audible source live, mirroring build-editor-command.ts's own
 * concat order exactly ("before" -> [extra, main], "after" -> [main,
 * extra]). Both the main and extra elements stay permanently mounted —
 * only one is ever actually playing/visible at a time, chosen by
 * `activeSegmentKind` — since swapping a single element's `src` at each
 * boundary crossing would mean a reload/seek stall every time the user
 * scrubs back and forth across it.
 *
 * A strict no-op when there's no enabled extra clip: `active` stays false
 * and every other field is inert, so the rest of the editor's normal
 * single-video playback path is completely untouched in the common case.
 */
export function useClipTimeline({
  mainVideoRef,
  extraVideoRef,
  extraClip,
  extraDuration,
  start,
  end,
}: {
  mainVideoRef: RefObject<HTMLVideoElement | null>;
  extraVideoRef: RefObject<HTMLVideoElement | null>;
  extraClip: EditorExtraClipState;
  /** Natural duration of the extra clip: the loaded extra video's own duration, or imageDuration for an image. 0 (and thus inactive) until known. */
  extraDuration: number;
  start: number;
  end: number;
}): ClipTimeline {
  const active = extraClip.enabled && !!extraClip.file && extraDuration > 0;
  const trimmedDuration = Math.max(0, end - start);
  const introOffset = active && extraClip.position === "before" ? extraDuration : 0;
  const totalDuration = active ? trimmedDuration + extraDuration : 0;
  const mainSegStart = extraClip.position === "before" ? introOffset : 0;
  const extraSegStart = extraClip.position === "before" ? 0 : trimmedDuration;

  const [virtualTime, setVirtualTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const activeSegmentKind: ClipSegmentKind = !active
    ? "main"
    : extraClip.position === "before"
      ? virtualTime < introOffset
        ? "extra"
        : "main"
      : virtualTime >= trimmedDuration
        ? "extra"
        : "main";

  // Every value the rAF/native-event callbacks below need, kept fresh across
  // renders without re-registering listeners on every tick (same pattern as
  // EditorTimeline.tsx's own `latest` ref).
  const latest = useRef({
    extraClip,
    trimmedDuration,
    totalDuration,
    introOffset,
    mainSegStart,
    extraSegStart,
    isPlaying,
    activeSegmentKind,
    virtualTime,
    start,
  });
  latest.current = {
    extraClip,
    trimmedDuration,
    totalDuration,
    introOffset,
    mainSegStart,
    extraSegStart,
    isPlaying,
    activeSegmentKind,
    virtualTime,
    start,
  };

  const imageRafRef = useRef<number | null>(null);
  const imageBaseRef = useRef<{ perfMs: number; virtualAtStart: number } | null>(null);

  const stopImageTimer = () => {
    if (imageRafRef.current !== null) cancelAnimationFrame(imageRafRef.current);
    imageRafRef.current = null;
    imageBaseRef.current = null;
  };

  const pauseAll = () => {
    mainVideoRef.current?.pause();
    extraVideoRef.current?.pause();
    stopImageTimer();
  };

  // Reset whenever the extra clip is disabled/removed, so a stale virtual
  // position never lingers into a later re-enable.
  useEffect(() => {
    if (!active) {
      pauseAll();
      setVirtualTime(0);
      setIsPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const seekMediaTo = (kind: ClipSegmentKind, vt: number) => {
    const { extraClip: ec, mainSegStart: ms, extraSegStart: es, start: s } = latest.current;
    if (kind === "main") {
      const el = mainVideoRef.current;
      if (el) el.currentTime = s + (vt - ms);
    } else if (ec.kind === "video") {
      const el = extraVideoRef.current;
      if (el) el.currentTime = vt - es;
    } else {
      imageBaseRef.current = { perfMs: performance.now(), virtualAtStart: vt };
    }
  };

  const imageTick = () => {
    const base = imageBaseRef.current;
    if (!base) return;
    const { introOffset: intro, totalDuration: total, extraClip: ec } = latest.current;
    const elapsed = (performance.now() - base.perfMs) / 1000;
    const vt = base.virtualAtStart + elapsed;
    const segEnd = ec.position === "before" ? intro : total;
    if (vt >= segEnd) {
      setVirtualTime(segEnd);
      advance();
      return;
    }
    setVirtualTime(vt);
    imageRafRef.current = requestAnimationFrame(imageTick);
  };

  const goToSegmentStart = (kind: ClipSegmentKind, playing: boolean) => {
    const { mainSegStart: ms, extraSegStart: es, extraClip: ec } = latest.current;
    const vt = kind === "main" ? ms : es;
    stopImageTimer();
    setVirtualTime(vt);
    seekMediaTo(kind, vt);
    if (kind === "main") {
      extraVideoRef.current?.pause();
      if (playing) mainVideoRef.current?.play().catch(() => {});
      else mainVideoRef.current?.pause();
    } else {
      mainVideoRef.current?.pause();
      if (ec.kind === "video") {
        if (playing) extraVideoRef.current?.play().catch(() => {});
        else extraVideoRef.current?.pause();
      } else if (playing) {
        imageBaseRef.current = { perfMs: performance.now(), virtualAtStart: vt };
        imageRafRef.current = requestAnimationFrame(imageTick);
      }
    }
  };

  function advance() {
    const { extraClip: ec, isPlaying: playing, activeSegmentKind: kind, totalDuration: total } = latest.current;
    const isLast = (ec.position === "before" && kind === "main") || (ec.position === "after" && kind === "extra");
    if (isLast) {
      pauseAll();
      setIsPlaying(false);
      setVirtualTime(total);
      return;
    }
    const nextKind: ClipSegmentKind = kind === "main" ? "extra" : "main";
    goToSegmentStart(nextKind, playing);
  }

  // Native boundary-crossing listeners for the real <video> elements.
  useEffect(() => {
    if (!active) return;
    const mainEl = mainVideoRef.current;
    const extraEl = extraClip.kind === "video" ? extraVideoRef.current : null;

    const onMainTime = () => {
      const {
        activeSegmentKind: kind,
        mainSegStart: ms,
        totalDuration: total,
        trimmedDuration: td,
        extraClip: ec,
        start: s,
      } = latest.current;
      if (kind !== "main" || !mainEl) return;
      const vt = ms + (mainEl.currentTime - s);
      const segEnd = ec.position === "before" ? total : td;
      if (vt >= segEnd - 0.02) advance();
      else setVirtualTime(vt);
    };
    const onExtraTime = () => {
      const { activeSegmentKind: kind, extraSegStart: es, totalDuration: total, introOffset: intro, extraClip: ec } =
        latest.current;
      if (kind !== "extra" || !extraEl) return;
      const vt = es + extraEl.currentTime;
      const segEnd = ec.position === "before" ? intro : total;
      if (vt >= segEnd - 0.02) advance();
      else setVirtualTime(vt);
    };

    mainEl?.addEventListener("timeupdate", onMainTime);
    extraEl?.addEventListener("timeupdate", onExtraTime);
    extraEl?.addEventListener("ended", advance);
    return () => {
      mainEl?.removeEventListener("timeupdate", onMainTime);
      extraEl?.removeEventListener("timeupdate", onExtraTime);
      extraEl?.removeEventListener("ended", advance);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, extraClip.kind]);

  if (!active) return INACTIVE;

  const togglePlay = () => {
    const { isPlaying: playing, activeSegmentKind: kind, extraClip: ec, virtualTime: vt } = latest.current;
    if (playing) {
      pauseAll();
      setIsPlaying(false);
      return;
    }
    setIsPlaying(true);
    if (kind === "main") {
      mainVideoRef.current?.play().catch(() => {});
    } else if (ec.kind === "video") {
      extraVideoRef.current?.play().catch(() => {});
    } else {
      imageBaseRef.current = { perfMs: performance.now(), virtualAtStart: vt };
      imageRafRef.current = requestAnimationFrame(imageTick);
    }
  };

  const seekTo = (vt: number) => {
    const clamped = Math.min(totalDuration, Math.max(0, vt));
    const kind: ClipSegmentKind =
      extraClip.position === "before"
        ? clamped < introOffset
          ? "extra"
          : "main"
        : clamped >= trimmedDuration
          ? "extra"
          : "main";
    stopImageTimer();
    setVirtualTime(clamped);
    seekMediaTo(kind, clamped);
    if (kind === "main") extraVideoRef.current?.pause();
    else mainVideoRef.current?.pause();
    if (isPlaying) {
      if (kind === "main") mainVideoRef.current?.play().catch(() => {});
      else if (extraClip.kind === "video") extraVideoRef.current?.play().catch(() => {});
      else {
        imageBaseRef.current = { perfMs: performance.now(), virtualAtStart: clamped };
        imageRafRef.current = requestAnimationFrame(imageTick);
      }
    }
  };

  return { active, totalDuration, introOffset, virtualTime, isPlaying, activeSegmentKind, togglePlay, seekTo };
}
