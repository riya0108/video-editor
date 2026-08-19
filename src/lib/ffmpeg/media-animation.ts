/**
 * Entrance/emphasis animations for overlays (images, videos, stickers) and
 * for intro/outro image clips. Two separate families because they need very
 * different ffmpeg techniques:
 *
 * - Overlay layers already sit inside a filter branch that gets composited
 *   onto the main video with `overlay=...:enable=between(t,start,end)` — the
 *   animation itself (rotate/dissolve/blur/reveal) runs on that branch's own
 *   clock, which starts at 0 when export begins, not when the overlay first
 *   becomes visible. So every expression here is re-based to `start` (the
 *   main-timeline second the overlay appears) via `max(t-start,0)`, otherwise
 *   a delayed overlay would already be mid-animation (or finished) the
 *   instant its enable gate opens.
 * - Intro/outro image clips are Ken Burns pan/zoom, built with `zoompan`,
 *   which needs a known pixel size and frame count up front — both of which
 *   are already known exactly for that branch (it's padded to the export
 *   canvas size), unlike overlay images whose height is aspect-derived and
 *   unknown until decode.
 */

export type OverlayAnimation = "none" | "rotate-in" | "dissolve-in" | "blur-in" | "reveal-left" | "reveal-right";
export type ImageEntranceAnimation = "none" | "pan-left" | "pan-right" | "zoom-in" | "zoom-out" | "ken-burns";

export const OVERLAY_ANIMATIONS: { id: OverlayAnimation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "rotate-in", label: "Rotate in" },
  { id: "dissolve-in", label: "Dissolve" },
  { id: "blur-in", label: "Blur in" },
  { id: "reveal-left", label: "Reveal →" },
  { id: "reveal-right", label: "Reveal ←" },
];

export const IMAGE_ENTRANCE_ANIMATIONS: { id: ImageEntranceAnimation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "ken-burns", label: "Ken Burns" },
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
  { id: "pan-left", label: "Pan →" },
  { id: "pan-right", label: "Pan ←" },
];

const ANIM_IN_DURATION = 0.6;

/**
 * Builds the filter chain fragment(s) that animate an already-scaled overlay
 * branch (`inLabel`, expected to already be `format=rgba`) into `outLabel`.
 * `startSec` is the main-timeline second the overlay becomes visible.
 */
export function buildOverlayAnimationFilters(
  animation: OverlayAnimation,
  inLabel: string,
  outLabel: string,
  startSec: number,
  newLabel: (prefix: "v") => string,
): string[] {
  const st = startSec.toFixed(2);
  const D = ANIM_IN_DURATION;
  // Re-bases each filter's time domain to the overlay's on-screen start,
  // clamped at 0 so nothing goes negative before it appears and holds
  // steady (fully animated-in) after `D` seconds.
  const lt = `max(t-${st}\\,0)`; // lowercase-t domain: rotate
  const uT = `max(T-${st}\\,0)`; // uppercase-T domain: geq, blend

  switch (animation) {
    case "rotate-in": {
      const angle = `(0.35)*(1-min(${lt}/${D}\\,1))`;
      return [`[${inLabel}]format=rgba,rotate=a='${angle}':c=none:ow=iw:oh=ih[${outLabel}]`];
    }
    case "dissolve-in": {
      return [`[${inLabel}]format=rgba,fade=t=in:st=${st}:d=${D}:alpha=1[${outLabel}]`];
    }
    case "blur-in": {
      const split1 = newLabel("v");
      const split2 = newLabel("v");
      const blurred = newLabel("v");
      const sharp = newLabel("v");
      const w = `min(${uT}/${D}\\,1)`;
      return [
        `[${inLabel}]format=rgba,split=2[${split1}][${split2}]`,
        `[${split1}]boxblur=12:1[${blurred}]`,
        `[${split2}]null[${sharp}]`,
        `[${blurred}][${sharp}]blend=all_expr='A*(${w})+B*(1-(${w}))'[${outLabel}]`,
      ];
    }
    case "reveal-left": {
      const prog = `min(${uT}/${D}\\,1)`;
      return [
        `[${inLabel}]format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(lt(X\\,W*${prog})\\,255\\,0)'[${outLabel}]`,
      ];
    }
    case "reveal-right": {
      const prog = `min(${uT}/${D}\\,1)`;
      return [
        `[${inLabel}]format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(gt(X\\,W*(1-${prog}))\\,255\\,0)'[${outLabel}]`,
      ];
    }
    default:
      return [];
  }
}

/**
 * Ken Burns pan/zoom for a static image clip already scaled+padded to
 * exactly `w`x`h`. Returns the bare `zoompan=...` filter fragment (no
 * brackets) to append to that branch's filter chain, or null for "none".
 * Replaces a trailing `fps=N` step — zoompan sets its own output fps.
 */
export function kenBurnsZoompanFilter(
  animation: ImageEntranceAnimation,
  w: number,
  h: number,
  durationSec: number,
  fps = 30,
): string | null {
  if (animation === "none") return null;
  const frames = Math.max(1, Math.round(durationSec * fps));
  const denom = Math.max(frames - 1, 1);

  // Centered zoom is always in-bounds by construction (x/y stay within
  // [0, iw - iw/zoom]), so zoom-only variants can't sample outside the frame.
  const centeredX = "iw/2-(iw/zoom/2)";
  const centeredY = "ih/2-(ih/zoom/2)";

  let z: string;
  let x: string;
  let y: string;
  switch (animation) {
    case "zoom-in":
      z = "min(zoom+0.0015,1.4)";
      x = centeredX;
      y = centeredY;
      break;
    case "zoom-out":
      z = "if(eq(on,0),1.4,max(zoom-0.0022,1.0))";
      x = centeredX;
      y = centeredY;
      break;
    case "pan-left":
      z = "1.18";
      x = `(on/${denom})*(iw-iw/zoom)`;
      y = centeredY;
      break;
    case "pan-right":
      z = "1.18";
      x = `(iw-iw/zoom)*(1-on/${denom})`;
      y = centeredY;
      break;
    case "ken-burns":
    default:
      z = "min(zoom+0.0012,1.28)";
      x = `(on/${denom})*(iw-iw/zoom)*0.5`;
      y = centeredY;
      break;
  }

  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps}`;
}
