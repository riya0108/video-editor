import { evenRound } from "../geometry";
import type { FractionRect } from "../../components/tool/video/RectOverlay";

export interface LogoRegion {
  id: string;
  rect: FractionRect;
  /** 0-100. Drives both blur intensity and how far the soft feathered edge extends. */
  strength: number;
  /** null = applied for the whole video. */
  timeRange: { start: number; end: number } | null;
}

/**
 * boxblur's chroma plane is subsampled 2x (yuv420p), and ffmpeg rejects a
 * blur radius that doesn't leave room in that subsampled plane — in practice
 * radius must stay under roughly a quarter of the crop's shorter side, or
 * ffmpeg errors out ("Invalid chroma_param radius value ..., must be >= 0
 * and < N") and the whole export fails. Verified empirically against ffmpeg
 * 8.1: a 24px-tall crop tops out at radius 5, a 54px-tall crop at radius 12.
 */
function maxBoxblurRadius(w: number, h: number): number {
  return Math.max(1, Math.floor(Math.min(w, h) / 4) - 1);
}

function strengthToRadius(strength: number, w: number, h: number): number {
  const wanted = Math.round((Math.max(0, Math.min(100, strength)) / 100) * 12) + 1;
  return Math.min(wanted, maxBoxblurRadius(w, h));
}

function escapeFilterArg(value: string): string {
  return value.replace(/([\\':])/g, "\\$1");
}

/**
 * One region = crop+blur the exact box, plus a second, lighter crop+blur of
 * a padded halo underneath it — a cheap way to fake a feathered edge with
 * only standard ffmpeg filters (no per-pixel alpha mask). Regions chain
 * sequentially so multiple logos/watermarks can be removed in one export.
 */
export function buildLogoRemovalFilter(
  regions: LogoRegion[],
  videoWidth: number,
  videoHeight: number,
): { filterComplex: string; outputLabel: string } {
  let current = "0:v";
  const parts: string[] = [];

  regions.forEach((region, i) => {
    const w = evenRound(region.rect.w * videoWidth);
    const h = evenRound(region.rect.h * videoHeight);
    const x = evenRound(region.rect.x * videoWidth);
    const y = evenRound(region.rect.y * videoHeight);

    const featherPx = Math.min(40, Math.max(6, Math.round(Math.min(w, h) * 0.15)));
    const px = evenRound(Math.max(0, x - featherPx), 0);
    const py = evenRound(Math.max(0, y - featherPx), 0);
    const pw = evenRound(Math.min(videoWidth - px, w + 2 * featherPx));
    const ph = evenRound(Math.min(videoHeight - py, h + 2 * featherPx));

    const outerRadius = Math.max(1, Math.round(strengthToRadius(region.strength, pw, ph) * 0.5));
    const innerRadius = strengthToRadius(region.strength, w, h);

    const enable = region.timeRange
      ? `:enable='${escapeFilterArg(`between(t,${region.timeRange.start},${region.timeRange.end})`)}'`
      : "";

    const base = `lb${i}`;
    const outerCrop = `lo${i}`;
    const innerCrop = `li${i}`;
    const outerBlur = `lob${i}`;
    const innerBlur = `lib${i}`;
    const afterOuter = `ls${i}o`;
    const afterInner = i === regions.length - 1 ? "logoout" : `ls${i}i`;

    parts.push(`[${current}]split=3[${base}][${outerCrop}][${innerCrop}]`);
    parts.push(`[${outerCrop}]crop=${pw}:${ph}:${px}:${py}[${outerCrop}c]`);
    parts.push(`[${outerCrop}c]boxblur=luma_radius=${outerRadius}:luma_power=1[${outerBlur}]`);
    parts.push(`[${innerCrop}]crop=${w}:${h}:${x}:${y}[${innerCrop}c]`);
    parts.push(`[${innerCrop}c]boxblur=luma_radius=${innerRadius}:luma_power=2[${innerBlur}]`);
    parts.push(`[${base}][${outerBlur}]overlay=${px}:${py}${enable}[${afterOuter}]`);
    parts.push(`[${afterOuter}][${innerBlur}]overlay=${x}:${y}${enable}[${afterInner}]`);

    current = afterInner;
  });

  return { filterComplex: parts.join(";"), outputLabel: current };
}
