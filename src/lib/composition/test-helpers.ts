import type { TextMeasurer } from "./text-layout";
import type { ResolveContext, SourceInfo } from "./resolve";

/** Deterministic measurer for Node tests: every glyph is 0.5em wide, letterSpacing between glyphs (not after the last), ascent/descent 0.8/0.2em — same contract as the canvas measurer. */
export const monoMeasurer: TextMeasurer = {
  measureWidth: (text, style) => {
    const n = Array.from(text).length;
    return n * style.fontSize * 0.5 + (n > 1 ? (n - 1) * style.letterSpacing : 0);
  },
  fontMetrics: (style) => ({ ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 }),
};

export function fakeContext(sources: Record<string, SourceInfo>, extra: Partial<ResolveContext> = {}): ResolveContext {
  return { getSourceInfo: (id) => sources[id], measurer: monoMeasurer, ...extra };
}
