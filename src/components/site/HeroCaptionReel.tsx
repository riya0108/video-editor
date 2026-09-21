import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import CaptionOverlay from "../tool/video/editor/CaptionOverlay";
import { CAPTION_STYLE_PRESETS } from "../../lib/captions/caption-styles";
import type { CaptionCue } from "../../lib/captions/types";

const REEL_PRESET_IDS = [
  "mrbeast",
  "hormozi",
  "bubble",
  "deep-glow",
  "highlighted",
  "liquid-glass",
  "prism",
  "glitch",
  "word-pop",
];

const PRESETS = REEL_PRESET_IDS.map((id) => CAPTION_STYLE_PRESETS.find((p) => p.id === id)).filter(
  (p): p is NonNullable<typeof p> => Boolean(p),
);

const SAMPLE_LINES = [
  ["This", "is", "insane"],
  ["Wait", "for", "it"],
  ["Just", "like", "this"],
  ["You", "won't", "believe", "this"],
  ["Built", "right", "in"],
  ["No", "editor", "needed"],
  ["Every", "style", "included"],
  ["Try", "it", "free"],
  ["Made", "for", "creators"],
];

const PER_WORD = 0.42;
const HOLD_SECONDS = 0.6;

function makeCue(words: string[]): CaptionCue {
  return {
    id: "reel",
    start: 0,
    end: words.length * PER_WORD,
    text: words.join(" "),
    words: words.map((w, i) => ({ text: w, start: i * PER_WORD, end: (i + 1) * PER_WORD })),
  };
}

/** A looping phone-reel mockup that cycles through the real caption style presets (via the same CaptionOverlay every editor uses), so the hero shows exactly what the tool produces rather than a mocked-up screenshot. */
export default function HeroCaptionReel() {
  const [index, setIndex] = useState(0);
  const [t, setT] = useState(0);
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  function toggleMuted() {
    const video = videoRef.current;
    const next = !muted;
    if (video) video.muted = next;
    setMuted(next);
  }
  // Keyed by line index (not the ever-incrementing cycle count) so this stays a fixed handful of entries for the life of the page.
  const cueForLine = useRef(new Map<number, CaptionCue>()).current;

  const lineIndex = index % SAMPLE_LINES.length;
  if (!cueForLine.has(lineIndex)) {
    cueForLine.set(lineIndex, makeCue(SAMPLE_LINES[lineIndex]));
  }
  const activeCue = cueForLine.get(lineIndex)!;

  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const duration = activeCue.end + HOLD_SECONDS;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = (now - start) / 1000;
      setT(elapsed);
      if (elapsed < duration) {
        raf = requestAnimationFrame(tick);
      } else {
        setIndex((i) => (i + 1) % PRESETS.length);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const preset = PRESETS[index % PRESETS.length];
  if (!preset) return null;

  return (
    <div className="relative mx-auto w-full max-w-[280px] animate-reel-float">
      <div className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-primary-500/20 blur-3xl dark:bg-primary-500/25" />

      {/* Caption showcase pulled out of the phone itself — a floating card beside it, so the video plays clean while this cycles through the real presets. Mostly sits outside the phone's left edge (only ~4% of the phone's width is covered) so the demo video stays visible, and stays translucent so it reads as floating rather than sitting on top of it. */}
      <div className="absolute -left-[165px] top-[54%] z-20 hidden w-44 -translate-y-1/2 -rotate-6 rounded-2xl border border-(--color-border) bg-(--color-surface)/40 px-4 py-3 text-center shadow-xl shadow-primary-950/10 backdrop-blur-md sm:-left-[197px] sm:block sm:w-52">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-(--color-text-muted)">
          Caption styles
        </p>
        {/* These presets are designed to sit on top of video footage (mostly light/white text with a heavy stroke or shadow), not on a plain UI surface — giving the preview its own fixed dark backdrop keeps every style readable regardless of the site's light/dark theme, instead of washing out on a light card. */}
        <div className="mt-1.5 flex min-h-[2.25rem] items-center justify-center rounded-lg bg-neutral-950/85 px-2 py-1.5">
          <CaptionOverlay style={preset.style} cue={activeCue} currentTime={t} scale={0.55} />
        </div>
        <p className="mt-1 text-caption font-medium text-primary-500">{preset.label}</p>
      </div>

      <div className="relative aspect-[9/16] overflow-hidden rounded-[2.5rem] border-4 border-neutral-950 bg-neutral-950 shadow-2xl shadow-primary-950/40">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full origin-center object-cover animate-phone-zoom-in"
          src="/videos/hero-phone-demo.mp4"
          autoPlay
          loop
          muted={muted}
          playsInline
          disablePictureInPicture
        />
        <div className="absolute inset-0 bg-black/10" />

        <div className="absolute left-1/2 top-2.5 h-5 w-20 -translate-x-1/2 rounded-full bg-black/70" />

        <button
          type="button"
          onClick={toggleMuted}
          aria-label={muted ? "Unmute preview" : "Mute preview"}
          className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-3 py-1 text-caption font-medium text-white/90 backdrop-blur-sm">
          {preset.label} style
        </div>
      </div>
    </div>
  );
}
