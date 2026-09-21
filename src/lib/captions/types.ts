export interface CaptionWord {
  text: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
}

export interface CaptionCue {
  id: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
  /** Per-word timestamps, only present when auto-generated with word-level timing. Powers karaoke highlighting. */
  words?: CaptionWord[];
  /** Overrides `CaptionStyle.fontSize` for just this cue — set when a single caption is resized from the floating toolbar while it's the selected/active one, instead of resizing every caption in the video. */
  fontSize?: number;
}

export type CaptionPosition = "top" | "center" | "bottom";

/** Corner rounding of the background/word box. */
export type CaptionShape = "block" | "bubble" | "pill";

/**
 * Entrance/idle motion applied to each word (karaoke/wordBox styles) or each
 * cue — the kinetic-typography menu, styled after Premiere Pro/After Effects
 * text-animation presets. `wave` and `shake` loop for as long as the
 * word/cue is on screen rather than firing once; the rest are one-shot
 * entrances. See CaptionOverlay's `animationClass` for the CSS each maps to,
 * and build-captions-filter's `growFontSizeExpr`/`entranceYOffsetExpr` for
 * which of these also get an ffmpeg-export approximation (scale/position
 * ramps only — drawtext can't blur, rotate, or clip-path).
 */
export type CaptionAnimation =
  | "none"
  | "pop"
  | "bounce"
  | "slide-up"
  | "glitch"
  | "elastic"
  | "drop-in"
  | "wave"
  | "blur-in"
  | "flip"
  | "shake"
  | "typewriter";

export interface CaptionStyle {
  fontId: string;
  color: string;
  fontSize: number;
  /** Anchor point of the caption block, as a percent (0-100) of the frame — freely draggable, not limited to top/center/bottom. */
  x: number;
  y: number;
  uppercase: boolean;
  background: boolean;
  backgroundColor: string;
  outline: boolean;
  outlineColor: string;
  /** Outline/border thickness in px (CSS) — also drives ffmpeg's drawtext borderw on export. */
  strokeWidth: number;
  /** Word-by-word highlight, synced to speech. Only takes effect for cues that have `words`. */
  karaoke: boolean;
  highlightColor: string;
  /** Fades each cue in/out instead of hard-cutting. */
  fade: boolean;
  /** Content-aware: renders a segmented cutout of the person on top of the caption, so it reads as sitting "behind" them. */
  occludeByPerson: boolean;
  /** Corner rounding of the background/word box. */
  shape: CaptionShape;
  /** Soft colored halo behind the text (Deep Glow). */
  glow: boolean;
  glowColor: string;
  /** Hard drop shadow under the text/box. */
  shadow: boolean;
  /** Multi-color gradient text fill (Prism). Empty = solid `color`. */
  gradient: string[];
  /** RGB channel-split "broken signal" look (Glitch). */
  glitch: boolean;
  /** Frosted translucent panel behind the text (Liquid Glass) — implies `background`. */
  backdropBlur: boolean;
  /** Draws a solid highlight box behind only the currently-spoken word (Hormozi/Highlighted), instead of karaoke's plain text recolor. Requires `karaoke`. */
  wordBox: boolean;
  /** Entrance motion, applied per-word when `karaoke`/`wordBox` is on, otherwise per-cue. */
  animation: CaptionAnimation;
  /**
   * Renders one word per cue — whichever is longest — in a larger, italic,
   * glowing font while the rest stays in the base style: the "normal, BIG
   * italic word, normal" viral caption look (e.g. "I CAN'T DRAW A
   * *straight* LINE"). Uses `highlightColor`/`glowColor` for that word's
   * color/glow.
   */
  emphasizeKeyword: boolean;
  /** Font for the word `emphasizeKeyword` singles out. */
  emphasisFontId: string;
  /**
   * Composition for the singled-out word. "inline" keeps it in the normal
   * text flow, just bigger (Interlock — the oversized script word wraps in
   * amongst the small caps words, tight leading making the lines interlock).
   * "overlay" renders it as a giant standalone backdrop with the rest of the
   * sentence layered smaller on top, centered on the same point (Blockbuster
   * — the movie-title look).
   */
  emphasisLayout: "inline" | "overlay";
  /**
   * Whether the singled-out word always renders uppercase (Blockbuster) or
   * keeps its original case (Interlock's lowercase script) — independent of
   * the base `uppercase` toggle, which only ever applies to the other words.
   */
  emphasisUppercase: boolean;
}

let counter = 0;
export function nextCaptionId(): string {
  counter += 1;
  return `cue-${Date.now()}-${counter}`;
}
