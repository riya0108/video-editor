import { useEffect, useRef, useState } from "react";
import { Ban, Check } from "lucide-react";
import { CAPTION_PRESETS, type CaptionPreset } from "../../../../lib/captions/caption-model";
import { MOTION_PRESETS, type MotionSlot } from "../../../../lib/animation/motion-presets";
import { TEXT_FONTS } from "../../../../lib/ffmpeg/fonts";

/**
 * TEMPLATE GALLERIES — visual pickers for caption templates and motion presets. Tiles are CSS approximations that
 * animate on hover (Web Animations API); the canvas renders the real thing through the engines.
 */

const cssFamily = (id: string) => TEXT_FONTS.find((f) => f.id === id)?.cssFontFamily ?? "inherit";
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

const SAMPLE = ["Make", "every", "word", "count"];

function CaptionTile({ preset, active, onPick }: { preset: CaptionPreset; active: boolean; onPick: () => void }) {
  const s = preset.style;
  const [hover, setHover] = useState(false);
  const [n, setN] = useState(SAMPLE.length);
  const textRef = useRef<HTMLSpanElement>(null);
  const anim = s.animation ?? "none";
  const wordMode = anim === "word-reveal" || anim === "word-single";

  useEffect(() => {
    if (!hover || reduceMotion()) {
      setN(SAMPLE.length);
      return;
    }
    if (wordMode) {
      let i = 1;
      setN(1);
      const id = setInterval(() => {
        i = (i % SAMPLE.length) + 1;
        setN(i);
      }, 380);
      return () => clearInterval(id);
    }
    const frames: Keyframe[] | null =
      anim === "pop" ? [{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1.08)", opacity: 1, offset: 0.6 }, { transform: "scale(1)" }] : anim === "rise" ? [{ transform: "translateY(14px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }] : anim === "fade" ? [{ opacity: 0 }, { opacity: 1 }] : null;
    const a = frames && textRef.current?.animate(frames, { duration: 450, iterations: Infinity, easing: "ease-out", endDelay: 700 });
    return () => a?.cancel();
  }, [hover, anim, wordMode]);

  // Each word re-pops in one-word mode.
  useEffect(() => {
    if (anim === "word-single" && hover && !reduceMotion()) textRef.current?.animate([{ transform: "scale(0.7)" }, { transform: "scale(1.1)", offset: 0.6 }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
  }, [n, anim, hover]);

  const shown = anim === "word-single" ? SAMPLE[n - 1] : anim === "word-reveal" ? SAMPLE.slice(0, n).join(" ") : SAMPLE.join(" ");
  const text = s.uppercase ? shown.toUpperCase() : shown;
  const bg = s.background ? `${s.backgroundColor}${Math.round(s.backgroundOpacity * 255).toString(16).padStart(2, "0")}` : undefined;
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-pressed={active}
      title={`Apply the "${preset.label}" caption style`}
      className={`group relative flex aspect-[4/3] flex-col overflow-hidden rounded-xl border text-left transition-all hover:-translate-y-0.5 ${active ? "border-primary-500 ring-2 ring-primary-500/40" : "border-(--color-border) hover:border-primary-400"}`}
      data-testid={`caption-template-${preset.id}`}
    >
      <span className="flex flex-1 items-center justify-center bg-[linear-gradient(160deg,#334155,#0f172a)] px-2">
        <span
          ref={textRef}
          className="inline-block text-center leading-tight"
          style={{
            fontFamily: cssFamily(s.fontFamily),
            fontWeight: s.fontWeight,
            fontStyle: s.italic ? "italic" : undefined,
            fontSize: Math.max(11, Math.min(20, s.fontSize / 4.2)),
            letterSpacing: s.letterSpacing ? `${Math.min(2, s.letterSpacing / 3)}px` : undefined,
            color: s.color,
            background: bg,
            padding: s.background ? "2px 7px" : undefined,
            borderRadius: s.background ? Math.min(14, s.borderRadius / 2) : undefined,
            WebkitTextStroke: s.stroke ? `${Math.min(1.6, s.strokeWidth / 5)}px ${s.strokeColor}` : undefined,
            paintOrder: "stroke fill",
            textShadow: s.shadow ? "0 2px 6px rgba(0,0,0,.6)" : undefined,
          }}
        >
          {text}
        </span>
      </span>
      <span className="flex items-center justify-between gap-1 bg-(--color-surface) px-2 py-1.5">
        <span className="truncate text-[11px] font-medium">{preset.label}</span>
        {anim !== "none" && <span className="shrink-0 rounded-full bg-accent-500/15 px-1.5 text-[10px] font-medium text-accent-600 dark:text-accent-300">animated</span>}
        {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary-500" />}
      </span>
    </button>
  );
}

export function CaptionTemplates({ activePresetId, hasCaptions, pendingId, onPick }: { activePresetId: string | null; hasCaptions: boolean; pendingId: string | null; onPick: (presetId: string) => void }) {
  const animated = CAPTION_PRESETS.filter((p) => p.style.animation && p.style.animation !== "none");
  const plain = CAPTION_PRESETS.filter((p) => !p.style.animation || p.style.animation === "none");
  const grid = (list: readonly CaptionPreset[]) => (
    <div className="grid grid-cols-2 gap-2">
      {list.map((p) => (
        <CaptionTile key={p.id} preset={p} active={(hasCaptions ? activePresetId : pendingId) === p.id} onPick={() => onPick(p.id)} />
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-4 px-2 pb-2" data-testid="caption-templates">
      {!hasCaptions && <p className="rounded-xl bg-(--color-bg-subtle) px-3 py-2 text-caption text-(--color-text-muted)">Pick a style now — it's applied as soon as captions are generated or imported below.</p>}
      <div>
        <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Animated</h3>
        {grid(animated)}
      </div>
      <div>
        <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Classic</h3>
        {grid(plain)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Motion presets
// ---------------------------------------------------------------------------

/** Preview of each preset on a small chip — the same motion, in CSS. */
export const MOTION_PREVIEW: Record<string, Keyframe[]> = {
  "fade-in": [{ opacity: 0 }, { opacity: 1 }],
  "rise-in": [{ transform: "translateY(10px)", opacity: 0 }, { transform: "none", opacity: 1 }],
  "drop-in": [{ transform: "translateY(-12px)", opacity: 0 }, { transform: "translateY(2px)", opacity: 1, offset: 0.7 }, { transform: "none" }],
  "slide-left-in": [{ transform: "translateX(14px)", opacity: 0 }, { transform: "none", opacity: 1 }],
  "slide-right-in": [{ transform: "translateX(-14px)", opacity: 0 }, { transform: "none", opacity: 1 }],
  "pop-in": [{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.6 }, { transform: "scale(1)" }],
  "zoom-in": [{ transform: "scale(1.8)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
  "spin-in": [{ transform: "rotate(-180deg) scale(0.3)", opacity: 0 }, { transform: "none", opacity: 1 }],
  "wipe-in": [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
  "fade-out": [{ opacity: 1 }, { opacity: 0 }],
  "sink-out": [{ transform: "none", opacity: 1 }, { transform: "translateY(10px)", opacity: 0 }],
  "rise-out": [{ transform: "none", opacity: 1 }, { transform: "translateY(-10px)", opacity: 0 }],
  "slide-left-out": [{ transform: "none", opacity: 1 }, { transform: "translateX(-14px)", opacity: 0 }],
  "pop-out": [{ transform: "scale(1)" }, { transform: "scale(1.15)", offset: 0.35 }, { transform: "scale(0.2)", opacity: 0 }],
  "zoom-out": [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.8)", opacity: 0 }],
  "wipe-out": [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }],
  pulse: [{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }],
  float: [{ transform: "none" }, { transform: "translateY(-5px)" }, { transform: "none" }],
  wiggle: [{ transform: "rotate(0)" }, { transform: "rotate(8deg)" }, { transform: "rotate(-8deg)" }, { transform: "rotate(0)" }],
  blink: [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }],
};

function MotionChip({ id, label, active, onPick, disabled }: { id: string | null; label: string; active: boolean; onPick: () => void; disabled?: boolean }) {
  const dot = useRef<HTMLSpanElement>(null);
  const play = () => {
    if (!id || reduceMotion()) return;
    const frames = MOTION_PREVIEW[id];
    if (frames) dot.current?.animate(frames, { duration: 600, easing: "ease-in-out", iterations: id.endsWith("-in") || id.endsWith("-out") ? 1 : 2 });
  };
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={play}
      onFocus={play}
      disabled={disabled}
      aria-pressed={active}
      className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium transition-colors disabled:opacity-40 ${active ? "border-primary-500 bg-primary-500/10 text-primary-700 dark:text-primary-200" : "border-(--color-border) hover:border-primary-400 hover:bg-(--color-bg-subtle)"}`}
      data-testid={`motion-${id ?? "none"}`}
    >
      <span className="flex h-6 w-10 items-center justify-center overflow-hidden">
        {id ? <span ref={dot} className="block h-4 w-6 rounded bg-linear-to-br from-primary-400 to-accent-400" /> : <Ban className="h-4 w-4 text-(--color-text-faint)" />}
      </span>
      {label}
    </button>
  );
}

/**
 * In / Out / Loop pickers. `active` says which slots hold motion now; `lastPicked` remembers what the user chose
 * per slot (keyframes don't record a preset name) so the chip stays highlighted.
 */
export function MotionPresetPicker({ active, lastPicked, locked, onPick }: { active: Record<MotionSlot, boolean>; lastPicked: Partial<Record<MotionSlot, string>>; locked: boolean; onPick: (slot: MotionSlot, presetId: string | null) => void }) {
  const slots: { slot: MotionSlot; label: string }[] = [
    { slot: "in", label: "In" },
    { slot: "loop", label: "Loop" },
    { slot: "out", label: "Out" },
  ];
  return (
    <div className="flex flex-col gap-3 px-3 pb-3" data-testid="motion-presets">
      {slots.map(({ slot, label }) => {
        const picked = active[slot] ? lastPicked[slot] : undefined;
        return (
          <div key={slot}>
            <h3 className="mb-1.5 flex items-center justify-between text-caption font-semibold">
              {label}
              <span className="text-[11px] font-normal text-(--color-text-faint)">{active[slot] ? "on" : "none"}</span>
            </h3>
            <div className="grid grid-cols-4 gap-1.5">
              <MotionChip id={null} label="None" active={!active[slot]} onPick={() => onPick(slot, null)} disabled={locked} />
              {MOTION_PRESETS.filter((p) => p.slot === slot).map((p) => (
                <MotionChip key={p.id} id={p.id} label={p.label} active={picked === p.id} onPick={() => onPick(slot, p.id)} disabled={locked} />
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-(--color-text-faint)">Presets write ordinary keyframes — fine-tune them below.</p>
    </div>
  );
}
