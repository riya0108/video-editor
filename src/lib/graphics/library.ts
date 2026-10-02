/**
 * Built-in SVG graphics for "Add shape -> Graphics". Simple geometric icons
 * authored for this project (no third-party artwork). Each is a single-color
 * shape on a 100x100 viewBox, so `tint` recolors it cleanly.
 */
export interface LibraryGraphic {
  id: string;
  label: string;
  markup: string;
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

export const GRAPHICS_LIBRARY: readonly LibraryGraphic[] = [
  { id: "heart", label: "Heart", markup: svg('<path fill="#ef4444" d="M50 88 L14 52 A20 20 0 0 1 50 22 A20 20 0 0 1 86 52 Z"/>') },
  { id: "star", label: "Star", markup: svg('<path fill="#facc15" d="M50 6 L61 38 L95 38 L67 58 L78 92 L50 71 L22 92 L33 58 L5 38 L39 38 Z"/>') },
  { id: "check", label: "Check badge", markup: svg('<circle cx="50" cy="50" r="44" fill="#22c55e"/><path d="M29 51 L44 66 L72 36" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: "speech", label: "Speech bubble", markup: svg('<path fill="#ffffff" d="M14 14 H86 A8 8 0 0 1 94 22 V62 A8 8 0 0 1 86 70 H42 L22 88 L26 70 H14 A8 8 0 0 1 6 62 V22 A8 8 0 0 1 14 14 Z"/>') },
  { id: "pin", label: "Location pin", markup: svg('<path fill="#3b82f6" d="M50 96 C50 96 16 58 16 36 A34 34 0 0 1 84 36 C84 58 50 96 50 96 Z"/><circle cx="50" cy="36" r="13" fill="#ffffff"/>') },
  { id: "play", label: "Play button", markup: svg('<circle cx="50" cy="50" r="46" fill="#dc2626"/><path d="M40 30 L72 50 L40 70 Z" fill="#ffffff"/>') },
];
