import { evenRound } from "../geometry";
import type { FractionRect } from "../../components/tool/video/RectOverlay";

export interface LogoRegion {
  id: string;
  rect: FractionRect;
  /** 0-100. Drives how wide a fuzzy edge ffmpeg blends the patch into. */
  strength: number;
  /** null = applied for the whole video. */
  timeRange: { start: number; end: number } | null;
}

function escapeFilterArg(value: string): string {
  return value.replace(/([\\':])/g, "\\$1");
}

/**
 * This build's `delogo` only takes x/y/w/h/show/enable — no blend-radius
 * option — so "strength" instead pads the removed box outward. A bigger box
 * gives delogo more surrounding pixels to interpolate from, which blends
 * better on busy backgrounds at the cost of removing a larger area.
 */
function strengthToPadding(strength: number, w: number, h: number): number {
  const wanted = Math.round((Math.max(0, Math.min(100, strength)) / 100) * 0.25 * Math.min(w, h));
  return Math.max(0, wanted);
}

/**
 * One region = one `delogo` filter — ffmpeg's built-in watermark remover,
 * which reconstructs the box from its edge pixels rather than just blurring
 * it. Regions chain sequentially so multiple logos can be removed in one
 * export. (An earlier version faked this with split+crop+boxblur+overlay,
 * but that multi-branch graph reliably hung the wasm multithreaded build —
 * delogo is a single filter per region and doesn't hit that.)
 */
export function buildLogoRemovalFilter(
  regions: LogoRegion[],
  videoWidth: number,
  videoHeight: number,
): { filterComplex: string; outputLabel: string } {
  let current = "0:v";
  const parts: string[] = [];

  regions.forEach((region, i) => {
    const baseW = evenRound(region.rect.w * videoWidth);
    const baseH = evenRound(region.rect.h * videoHeight);
    const baseX = evenRound(region.rect.x * videoWidth);
    const baseY = evenRound(region.rect.y * videoHeight);

    const pad = strengthToPadding(region.strength, baseW, baseH);
    const x = evenRound(Math.max(0, baseX - pad));
    const y = evenRound(Math.max(0, baseY - pad));
    const w = evenRound(Math.min(videoWidth - x, baseW + 2 * pad));
    const h = evenRound(Math.min(videoHeight - y, baseH + 2 * pad));

    const enable = region.timeRange
      ? `:enable='${escapeFilterArg(`between(t,${region.timeRange.start},${region.timeRange.end})`)}'`
      : "";

    const out = i === regions.length - 1 ? "logoout" : `ld${i}`;
    parts.push(`[${current}]delogo=x=${x}:y=${y}:w=${w}:h=${h}${enable}[${out}]`);
    current = out;
  });

  return { filterComplex: parts.join(";"), outputLabel: current };
}
