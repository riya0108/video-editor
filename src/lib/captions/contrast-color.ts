/** Picks black or white, whichever reads better on top of `hexColor` — used to keep word-box text (Hormozi/Highlighted styles) legible against any highlight color. */
export function contrastTextColor(hexColor: string): "#000000" | "#ffffff" {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
}
