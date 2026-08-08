export interface CaptionCue {
  id: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
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
}

let counter = 0;
export function nextCaptionId(): string {
  counter += 1;
  return `cue-${Date.now()}-${counter}`;
}
