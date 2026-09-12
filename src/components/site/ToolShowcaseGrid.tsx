import { Captions, Eraser, Gauge, MicOff, Scissors, Sparkles } from "lucide-react";
import { getToolPath } from "../../lib/tools-registry";

type PreviewKind = "timeline" | "captions" | "background" | "filler" | "upscale" | "voice";

interface ShowcaseTool {
  kind: PreviewKind;
  name: string;
  description: string;
  icon: typeof Sparkles;
  href: { category: "video" | "audio" | "speech"; slug: string };
}

const SHOWCASE: ShowcaseTool[] = [
  {
    kind: "timeline",
    name: "Video Editor",
    description: "A full timeline with clips, text, audio, and undo/redo history.",
    icon: Scissors,
    href: { category: "video", slug: "video-editor" },
  },
  {
    kind: "captions",
    name: "Auto Captions",
    description: "MrBeast, Hormozi, Glitch, Liquid Glass — 20+ styles, word-by-word.",
    icon: Captions,
    href: { category: "video", slug: "add-text" },
  },
  {
    kind: "background",
    name: "Remove Background",
    description: "Swap or blur the background — with or without a green screen.",
    icon: Eraser,
    href: { category: "video", slug: "remove-background" },
  },
  {
    kind: "filler",
    name: "Remove Filler Words",
    description: "Cuts out the \"um\"s and \"uh\"s automatically.",
    icon: MicOff,
    href: { category: "video", slug: "remove-filler-words" },
  },
  {
    kind: "upscale",
    name: "AI Upscale",
    description: "Sharpen soft or low-res footage with an on-device model.",
    icon: Sparkles,
    href: { category: "video", slug: "upscale-media" },
  },
  {
    kind: "voice",
    name: "Text to Speech",
    description: "Natural AI voices and voice cloning, generated in-browser.",
    icon: Gauge,
    href: { category: "speech", slug: "text-to-speech" },
  },
];

function PreviewScene({ kind }: { kind: PreviewKind }) {
  if (kind === "timeline") {
    return (
      <div className="relative flex h-full w-full flex-col justify-center gap-1.5 px-4">
        {[70, 100, 55].map((w, i) => (
          <div
            key={i}
            className="h-3 rounded-sm bg-gradient-to-r from-primary-400 to-accent-400 opacity-80"
            style={{ width: `${w}%` }}
          />
        ))}
        <div className="animate-playhead-sweep absolute top-2 bottom-2 w-0.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
      </div>
    );
  }
  if (kind === "captions") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <span className="showcase-caption-pop rounded-md bg-black px-3 py-1 text-body-sm font-extrabold text-white">
          JUST <span className="text-warning-500">LIKE</span> THIS
        </span>
      </div>
    );
  }
  if (kind === "background") {
    return (
      <div className="relative h-full w-full overflow-hidden">
        <div className="absolute inset-0 bg-checkerboard" />
        <div className="absolute inset-0 bg-gradient-to-br from-primary-500 to-accent-500" />
        <div className="animate-wipe-reveal absolute inset-0 bg-checkerboard" />
        <div className="absolute inset-x-0 bottom-0 h-4/5 -translate-x-1/2 left-1/2 w-10 rounded-t-full bg-white/90" />
      </div>
    );
  }
  if (kind === "filler") {
    return (
      <div className="flex h-full w-full items-center justify-center gap-1 px-4">
        {[40, 70, 30, 90, 20, 60, 45, 80, 35].map((h, i) => (
          <div
            key={i}
            className="animate-bar-bounce w-1.5 rounded-full bg-accent-500"
            style={{ height: `${h}%`, animationDelay: `${i * 0.09}s` }}
          />
        ))}
      </div>
    );
  }
  if (kind === "upscale") {
    return (
      <div className="relative h-full w-full overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-neutral-400 to-neutral-600 blur-[3px]" />
        <div className="absolute inset-0 bg-gradient-to-br from-primary-400 to-accent-400 [clip-path:inset(0_0_0_50%)]" />
        <div className="animate-clarity-sweep absolute top-0 bottom-0 w-0.5 bg-white/90 shadow-[0_0_10px_rgba(255,255,255,0.9)]" />
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center gap-1">
      {[35, 60, 90, 55, 75, 40, 65].map((h, i) => (
        <div
          key={i}
          className="animate-bar-bounce w-1.5 rounded-full bg-gradient-to-t from-primary-500 to-accent-400"
          style={{ height: `${h}%`, animationDelay: `${i * 0.11}s`, animationDuration: "1.3s" }}
        />
      ))}
    </div>
  );
}

/** Flagship-tool cards with a tiny looping CSS "motion graphic" per tool, so the homepage shows a hint of each tool actually doing something instead of a static icon. */
export default function ToolShowcaseGrid() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {SHOWCASE.map((tool) => (
        <a
          key={tool.name}
          href={getToolPath({ category: tool.href.category, slug: tool.href.slug })}
          className="group relative flex flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary-300 hover:shadow-xl hover:shadow-primary-500/10 dark:hover:border-primary-800"
        >
          <div className="relative h-28 w-full overflow-hidden bg-neutral-900">
            <PreviewScene kind={tool.kind} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
          </div>
          <div className="flex flex-1 items-start gap-3 p-5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-100 text-primary-600 transition-transform duration-300 group-hover:scale-110 dark:bg-primary-950 dark:text-primary-300">
              <tool.icon size={17} />
            </span>
            <div>
              <h3 className="font-semibold tracking-tight group-hover:text-primary-600">{tool.name}</h3>
              <p className="mt-1 text-body-sm text-(--color-text-muted)">{tool.description}</p>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
