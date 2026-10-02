# Phase 6 — Text & Typography Engine: Test Report

Date: 2026-10-02. Environment: macOS, Node 22, Vitest 5, Chrome via chrome-devtools-mcp (real font loading and real video decode), Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite (`npx vitest run`) | **722 / 722 passed** (73 files). The 677 pre-Phase-6 tests all still pass. |
| New text suite (`src/lib/text/text-engine.test.ts`) | **44 / 44 passed**, covering all 32 required items plus error handling |
| Related new tests | v2→v3 text migration (`serialize.test.ts`), nearest-handle picking regression (`viewport.test.ts`) |
| Type checking (`tsc --noEmit`) | **0 errors** |
| `astro check` | **0 errors, 0 warnings**. 15 hints, all pre-existing in `src/lib/matting/**`, `src/lib/media/**`, `src/lib/upscale/**`; none in Phase 6 files. |
| Linting | **No linter is configured in this repo** (no ESLint/Biome config or script); `astro check` + `tsc` are the static checks. |
| Production build (`astro build`) | **Success**; `/tools/video/composition-preview` prerenders |
| Manual / visual QA | All 19 checklist items pass (below) |

**Mutation checks** (proving the key tests can fail):
- Using raw shadow offsets fails test 16.
- Not re-pinning position after a text resize fails test 18.
- Reverting handle picking to a fixed priority order fails the new regression test.

## Automated tests (1–32)

All in `src/lib/text/text-engine.test.ts` unless noted. Geometry is asserted through `resolveFrame` / `layoutText` (what renderers use). Drawing is asserted with a recording 2D context, which logs every `fillText`/`strokeText`/`roundRect`/`fill` with the canvas state in effect (`fillStyle`, `globalAlpha`, `shadow*`, `letterSpacing`, …).

| # | Test | Asserts |
|---|---|---|
| 1 | Create text layer | Clip on its own new front track, at the playhead, selected; one undo removes track + clip |
| 2 | Edit text | Re-layout (1 → 2 lines); old content object not mutated |
| 3 | Delete text | Not rendered after delete; undo restores |
| 4 | Duplicate text | New id; editing the copy (text + color) leaves the original unchanged |
| 5 | Change font | Every registry font resolves to a stack ending in a generic family; canvas font string changes |
| 6 | Font size | Box scales linearly; 1e9 / −4 / NaN clamp to 2000 / 1 / default |
| 7 | Weight | 651 → 700; Poppins (ships 700 only) at 400 → 700 with warning; Geist variable keeps 300 |
| 8 | Color | Every glyph fill uses the text color |
| 9 | Alignment | left/center/right x positions exact; justify stretches gaps so the last word ends at the box edge, last line unjustified; vertical top/middle/bottom offsets |
| 10 | Line height | Baseline spacing = fontSize × lineHeight; half-leading baseline position exact |
| 11 | Letter spacing | Included in measurement (between glyphs only); native `ctx.letterSpacing` path and per-grapheme fallback both exact |
| 12 | Multiline | `\n` / `\r\n` paragraphs, blank lines kept |
| 13 | Wrapping | Box width minus padding; over-long words break at grapheme boundaries; skin-toned emoji never split; point text wraps only at maxWidth |
| 14 | Background | Rounded rect = content box size, radius 10, alpha 0.8, drawn before glyphs, grows with text |
| 15 | Stroke | strokeText before fillText, lineWidth = 2 × strokeWidth, color correct; off = no stroke |
| 16 | Shadow | Offset/blur scale with the render scale (0.5 preview → half); rotate with the layer (90° turns +x into +y); fill pass casts no second shadow |
| 17 | Move | Bounds shift exactly |
| 18 | Resize text box | Side handle → box mode, re-wrap, fontSize and scale unchanged, opposite top corner pinned, one undo step; corner → fontSize/padding/stroke scale, transform scale untouched |
| 19 | Rotate | About the anchor; bounds swap |
| 20 | Opacity | globalAlpha on glyphs; 0 culls the layer |
| 21 | Timeline duration | Visible only in [start, end) (the brief's 0–3 s / 3–6 s example); trim extends; move shifts |
| 22 | Layer ordering | Paint order follows tracks; reorder flips it |
| 23–24 | Undo / Redo | 14 operations (text, font, size, color, align, line height, letter spacing, background, stroke, shadow, move, box resize, rotate, duplicate) are one step each; undo/redo returns the identical timeline snapshots |
| 25–26 | Save / reload | Every TextStyle field + transform + timing + layer order round-trips; matrix and layout identical after reload |
| 27 | Missing font | Unknown family → own stack + `sans-serif` fallback (status reported); CSS-injection-shaped family → default font; garbage style values still resolve and render |
| 28 | Transparent background | No backdrop fill; only glyphs painted |
| 29 | Background-removed media underneath | Order bg video → matted cutout (via destination-in scratch) → text → logo |
| 30–32 | 1080×1920, 1920×1080, 1080×1080 | New text centered; a lower-third keeps its relative position (x 50%, y 80%) through every composition switch and stays on canvas |
| — | Error handling | Empty text not drawn and doesn't crash; huge box / extreme spacing / line height clamp; box without width → point; 4000-word text lays out < 2 s and the second frame is a cache hit (< 5 ms, same object); v2 names migrate; unknown future keys preserved |

## Manual / live testing (in the editor, chrome-devtools-mcp)

| Flow | Result |
|---|---|
| **Add text** button | Layer created at the front, on the timeline, edit mode opened with "Type something..." fully selected (selection 0–17) |
| Typing (real keyboard) | `BREAKING NEWS` ⏎ `Live 👋 café`: typed text replaced the selection; Enter → newline; emoji and accents fine. "BREAKING" contains H/C/V shortcut letters, and none leaked to the canvas (no flip, no crop mode) |
| Commit (Esc) | Text committed; overlay closed; exactly 2 undo steps (create + one edit session) |
| Double-click to re-edit | Edit mode re-entered, textarea focused, all text selected |
| Timeline panel | Select from timeline; drag-move +1 s; edge-trim end +1 s (90 → 120 frames); 2 undo steps |
| Canvas side-handle resize | Single-line text → box mode, re-wraps 1 → 3 lines, fontSize stays 40, scale stays 1, top-left pinned (0.0000 px drift), 1 undo step (**after the bug fix below**) |
| Inspector | Font family, align right, shadow toggle: 3 changes = 3 undo steps; font-substitution warning shown for Poppins 400 |
| Copy / paste style | Pasted style identical; target's text untouched |
| Persistence (save → close → reopen) | Frame 60 of a 1080×1080 project with **16 text layers**, rendered by the final renderer before Save and after a full page reload + Load: **pixel-identical** (hash `152080e7` both) |

## Visual QA checklist (final-renderer output, inspected as PNGs)

Rendered with `FinalRenderer.renderFrame` (the export path), saved to `.tmp-test-assets/phase5/qa/` (git-ignored):
- `01-add-text.png`
- `02-scene-16x9.png`
- `03-scene-9x16.png`
- `04-1x1-timeline.png`

| | Item | Result |
|---|---|---|
| A | Large headline (Anton 150 px + stroke) | ✅ crisp, stroke outside glyphs, no clipping |
| B | Small subtitle (28 px Geist 500) | ✅ sharp at small size |
| C | Multiline paragraph (justified box) | ✅ even word gaps, last line left, correct line spacing |
| D | Bold text (Geist 900) | ✅ |
| E | Italic (Playfair) | ✅ (synthetic oblique; Playfair italic isn't bundled, and the inspector says so) |
| F | Long text (90-char unbroken token) | ✅ breaks inside its box, no overflow |
| G | Short text ("Hi") | ✅ |
| H | Centered text | ✅ |
| I | Right-aligned (fixed box) | ✅ right edges flush |
| J | Text over video | ✅ |
| K | Text over transparent / background-removed subject | ✅ composites above the matted PiP |
| L | Text over image | ✅ |
| M | Text over background shape | ✅ |
| N | Text with stroke | ✅ |
| O | Text with shadow | ✅ soft shadow, single (not doubled) |
| P | Text with background box ("BREAKING NEWS", black 80%, padding 20, radius 10) | ✅ auto-sized to content |
| Q | Rotated text (−12°) | ✅ |
| R | Multiple text layers | ✅ six-plus layers per scene, correct z-order |
| S | Appear/disappear with timeline | ✅ Text A only at 1 s, Text B only at 4 s |

Checked for clipping, wrapping, baseline errors, blur, alignment, scaling, rotation, z-order, and persistence: no issues found.

## Bugs found and fixed during Phase 6 testing

1. **Side handles unreachable on thin layers.** `hitSelectionHandle` checked corners before edges. On a single line of text (or any short layer), the corners sit inside the 9 px hit radius of the side handles, so dragging a side handle always grabbed a corner. For text that meant scaling the font instead of re-wrapping. Fixed by picking the *nearest* handle. The regression test fails on the old logic.
2. **`cachedTextLayout` returned different objects on a cache hit vs. a miss** (a hit returned the internal cache entry). Fixed to always return the same result object; caught by the caching test.
3. **Two test-fixture bugs** (a justify test whose text was too short to wrap, and a serialize fixture with an undefined style that v3 now legitimately fills). Fixed in the tests, not by weakening the code.

## Performance observations

- Text layout is cached per immutable content object. A 4000-word paragraph lays out in under 2 s in Node with the fake measurer, and every later frame is a cache hit (< 5 ms). In the browser, preview frames with ~16 text layers render in a few ms (preview stats readout).
- Measurement is cached per (font, letter spacing, string). Font metrics are cached per font. Both caches invalidate (generation bump) when web fonts finish loading.
- Final renders at 1080×1080 with 16 text layers took well under a second.
- Unrelated layers aren't re-laid-out: only a clip whose content object changed gets a new layout.

## Known issues / limitations

- No real italic faces are bundled (`@fontsource` imports are upright only), so italics are synthetic obliques. The inspector warns.
- Several bundled families ship a single weight (e.g. Poppins 700). Other weights snap to the nearest shipped weight, with a warning, rather than faking bold.
- In edit mode the DOM textarea replicates the canvas look closely but not pixel-perfectly (browser text vs. canvas text). The canvas render is authoritative after commit.
- Canvas `letterSpacing` support: native in current Chrome/Safari/Firefox; older browsers use the per-grapheme fallback, which loses kerning when letter spacing ≠ 0.
- Justify stretches word gaps only (no hyphenation, no letter-level justification).
- RTL/bidi text renders through the platform text stack, but wrapping and alignment are left-to-right oriented. Not a Phase 6 goal.
- The screenshot tool in this environment repeatedly timed out, so visual QA used final-renderer PNGs instead of screen captures. That checks the export output itself, but not the on-screen chrome (handles, edit frame).
