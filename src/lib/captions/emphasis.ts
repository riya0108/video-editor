/**
 * Index of the longest word (ties go to the earlier one) — the automatic
 * pick for `CaptionStyle.emphasizeKeyword`, shared between the live preview
 * (CaptionOverlay) and the burned-in ffmpeg export (build-captions-filter)
 * so both single out the same word.
 */
export function pickEmphasisIndex(words: string[]): number {
  let best = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i].replace(/[^\p{L}\p{N}]/gu, "").length > words[best].replace(/[^\p{L}\p{N}]/gu, "").length) best = i;
  }
  return best;
}

/**
 * How much bigger the singled-out word renders relative to `style.fontSize`
 * in "inline" `emphasisLayout` (Interlock) — shared between the karaoke
 * pixel-layout measurement (karaoke-layout.ts) and the drawtext filter that
 * actually draws it (build-captions-filter.ts) so the pre-measured x offset
 * of every word *after* it accounts for its true rendered width instead of
 * assuming the base font size, which is what caused later words to overlap
 * it in exported video.
 */
export const INLINE_EMPHASIS_SCALE = 2.6;
