import type { ClipKind } from "../timeline/clip";

/**
 * AUDIO MODEL (AUDIO_ENGINE_ARCHITECTURE.md §2). Per-clip audio settings live
 * on `clip.audio` (undefined = defaults), for every kind that can carry sound:
 * audio clips and the soundtrack of video / overlay clips. Pure data — the
 * source media is never modified; gain, volume, fades and normalization are
 * applied when the mix is played or exported.
 */

export type AudioRole = "music" | "voiceover" | "sfx" | "ambient" | "original";

export const AUDIO_ROLES: readonly { role: AudioRole; label: string }[] = [
  { role: "music", label: "Music" },
  { role: "voiceover", label: "Voiceover" },
  { role: "sfx", label: "Sound effect" },
  { role: "ambient", label: "Ambient" },
  { role: "original", label: "Original (video sound)" },
];

/** Shape of a fade: linear amplitude, equal-power (constant perceived loudness through crossfades) or a smooth S-curve. */
export type FadeCurve = "linear" | "equal-power" | "s-curve";

export interface AudioNormalization {
  /** Target peak, dBFS. */
  targetDb: number;
  /** Peak measured over the clip's source range when normalization was applied, dBFS. */
  peakDb: number;
  /** Resulting make-up gain (targetDb - peakDb), dB. Stored so a reload reproduces the mix without re-analysis. */
  gainDb: number;
}

export interface ClipAudio {
  role?: AudioRole;
  /** Mix level, linear 0..2 (1 = unity). Animatable at "audio.volume" (volume automation). */
  volume: number;
  /** Static trim gain in dB, -60..+24. Animatable at "audio.gainDb". */
  gainDb: number;
  /** Fade lengths in frames (clip-relative from the start / to the end). */
  fadeInFrames: number;
  fadeOutFrames: number;
  fadeCurve: FadeCurve;
  muted: boolean;
  normalize?: AudioNormalization;
}

export const DEFAULT_CLIP_AUDIO: Readonly<ClipAudio> = Object.freeze({ volume: 1, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, fadeCurve: "linear" as FadeCurve, muted: false });

export const VOLUME_RANGE = { min: 0, max: 2 } as const;
export const GAIN_DB_RANGE = { min: -60, max: 24 } as const;
export const NORMALIZE_TARGET_RANGE = { min: -30, max: 0 } as const;
/** Below this, a clip is treated as silent (normalizing silence would apply absurd gain). */
export const SILENCE_DB = -90;

/** Clip kinds whose source can carry sound. */
export function isAudibleKind(kind: ClipKind): boolean {
  return kind === "audio" || kind === "video" || kind === "overlay";
}

export const clampVolume = (v: number) => (Number.isFinite(v) ? Math.min(VOLUME_RANGE.max, Math.max(VOLUME_RANGE.min, v)) : 1);
export const clampGainDb = (v: number) => (Number.isFinite(v) ? Math.min(GAIN_DB_RANGE.max, Math.max(GAIN_DB_RANGE.min, v)) : 0);

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

/** The clip's audio settings with defaults filled in. */
export function clipAudioOf(clip: { audio?: Partial<ClipAudio> }): ClipAudio {
  return { ...DEFAULT_CLIP_AUDIO, ...clip.audio } as ClipAudio;
}

const FADE_CURVES: FadeCurve[] = ["linear", "equal-power", "s-curve"];
const ROLES = AUDIO_ROLES.map((r) => r.role);

/** Validates/normalizes clip audio from untrusted data (project files, patches). Null if not an object. */
export function normalizeClipAudio(raw: unknown): ClipAudio | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const frames = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const out: ClipAudio = {
    volume: typeof r.volume === "number" ? clampVolume(r.volume) : 1,
    gainDb: typeof r.gainDb === "number" ? clampGainDb(r.gainDb) : 0,
    fadeInFrames: frames(r.fadeInFrames),
    fadeOutFrames: frames(r.fadeOutFrames),
    fadeCurve: FADE_CURVES.includes(r.fadeCurve as FadeCurve) ? (r.fadeCurve as FadeCurve) : "linear",
    muted: r.muted === true,
  };
  if (ROLES.includes(r.role as AudioRole)) out.role = r.role as AudioRole;
  const n = r.normalize as Record<string, unknown> | undefined;
  if (n && typeof n === "object" && [n.targetDb, n.peakDb, n.gainDb].every((v) => typeof v === "number" && Number.isFinite(v))) {
    out.normalize = { targetDb: n.targetDb as number, peakDb: n.peakDb as number, gainDb: Math.min(GAIN_DB_RANGE.max, Math.max(GAIN_DB_RANGE.min, n.gainDb as number)) };
  }
  return out;
}

/** Peak-normalization result for a measured peak. Throws on silence (no meaningful gain exists). */
export function normalizationFor(peakDb: number, targetDb: number): AudioNormalization {
  if (!(peakDb > SILENCE_DB)) throw new Error("The clip is silent — there's nothing to normalize.");
  const target = Math.min(NORMALIZE_TARGET_RANGE.max, Math.max(NORMALIZE_TARGET_RANGE.min, targetDb));
  const gainDb = Math.min(GAIN_DB_RANGE.max, Math.max(GAIN_DB_RANGE.min, target - peakDb));
  return { targetDb: target, peakDb, gainDb };
}

/** Fade gain for normalized position t in [0,1] (0 = silent end of the fade). */
export function fadeShape(t: number, curve: FadeCurve): number {
  const x = Math.min(1, Math.max(0, t));
  switch (curve) {
    case "equal-power":
      return Math.sin((x * Math.PI) / 2);
    case "s-curve":
      return (1 - Math.cos(Math.PI * x)) / 2;
    default:
      return x;
  }
}

/**
 * Fade multiplier at clip-relative position `local` (frames, may be fractional) of a clip `duration` frames long.
 * Fades longer than the clip (e.g. after a trim) are scaled down proportionally so they never overlap — the stored
 * lengths are kept, so un-trimming restores them.
 */
export function fadeGainAt(local: number, duration: number, a: Pick<ClipAudio, "fadeInFrames" | "fadeOutFrames" | "fadeCurve">): number {
  let fi = a.fadeInFrames;
  let fo = a.fadeOutFrames;
  if (fi + fo > duration && fi + fo > 0) {
    const k = duration / (fi + fo);
    fi *= k;
    fo *= k;
  }
  let g = 1;
  if (fi > 0 && local < fi) g *= fadeShape(local / fi, a.fadeCurve);
  if (fo > 0 && local > duration - fo) g *= fadeShape((duration - local) / fo, a.fadeCurve);
  return g;
}

/** Guesses a clip's role from its file name (the user can change it). */
export function guessAudioRole(fileName: string): AudioRole {
  const n = fileName.toLowerCase();
  if (/\b(vo|voice|voiceover|narrat\w*|speech|dialog\w*|podcast|interview)\b|voice/.test(n)) return "voiceover";
  if (/\b(sfx|fx|whoosh|swoosh|click|hit|impact|boom|ding|pop|beep|riser|transition)\b|sfx/.test(n)) return "sfx";
  if (/\b(ambien\w*|room ?tone|atmos\w*|rain|wind|crowd|nature|forest|city|cafe|noise)\b|ambien/.test(n)) return "ambient";
  return "music";
}
