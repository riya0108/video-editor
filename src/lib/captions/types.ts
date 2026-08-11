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
}

export type CaptionPosition = "top" | "center" | "bottom";

export interface CaptionStyle {
  fontId: string;
  color: string;
  fontSize: number;
  position: CaptionPosition;
  uppercase: boolean;
  background: boolean;
  backgroundColor: string;
  outline: boolean;
  outlineColor: string;
  /** Word-by-word highlight, synced to speech. Only takes effect for cues that have `words`. */
  karaoke: boolean;
  highlightColor: string;
}

let counter = 0;
export function nextCaptionId(): string {
  counter += 1;
  return `cue-${Date.now()}-${counter}`;
}
