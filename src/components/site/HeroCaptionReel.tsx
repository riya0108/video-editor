import { useEffect, useRef, useState } from "react";
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
      <div className="relative aspect-[9/16] overflow-hidden rounded-[2.5rem] border-4 border-neutral-950 bg-neutral-950 shadow-2xl shadow-primary-950/40">
        <div
          className="animate-reel-bg-pan absolute inset-0 bg-[length:180%_180%,180%_180%,100%_100%]"
          style={{
            backgroundImage:
              "radial-gradient(circle, #7c3aed, transparent 55%), radial-gradient(circle, #0891b2, transparent 50%), linear-gradient(160deg, #0f0a1f, #1a1033)",
          }}
        />
        <div className="absolute inset-0 bg-black/10" />

        <div className="absolute inset-x-0 top-[42%] flex justify-center px-5 text-center">
          <CaptionOverlay style={preset.style} cue={activeCue} currentTime={t} scale={0.42} />
        </div>

        <div className="absolute left-1/2 top-2.5 h-5 w-20 -translate-x-1/2 rounded-full bg-black/70" />

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-3 py-1 text-caption font-medium text-white/90 backdrop-blur-sm">
          {preset.label} style
        </div>
      </div>
    </div>
  );
}
