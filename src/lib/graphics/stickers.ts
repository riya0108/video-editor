/**
 * STICKERS — multi-color SVG stickers authored for this project (no third-party artwork, no attribution needed).
 * Added to the timeline exactly like library graphics (svgSpecFromMarkup -> a graphic layer), so they scale
 * crisply at any resolution and take motion presets, effects and masks like any other layer.
 */

export interface Sticker {
  id: string;
  label: string;
  category: "Social" | "Callouts" | "Shapes & marks" | "Reactions";
  markup: string;
}

const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const FONT = `font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900"`;

/** A pill button with a label (Subscribe, Follow...). */
const pill = (label: string, fill: string, w = 340) =>
  svg(w, 100, `<rect x="4" y="8" width="${w - 8}" height="84" rx="42" fill="#00000033"/><rect x="0" y="0" width="${w - 8}" height="84" rx="42" fill="${fill}"/><text x="${(w - 8) / 2}" y="55" text-anchor="middle" ${FONT} font-size="34" fill="#ffffff">${label}</text>`);

/** A starburst badge with a word. */
function burst(label: string, fill: string, textFill = "#ffffff", points = 14): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 96 : 76;
    const a = (Math.PI / points) * i - Math.PI / 2;
    pts.push(`${(100 + Math.cos(a) * r).toFixed(1)},${(100 + Math.sin(a) * r).toFixed(1)}`);
  }
  return svg(200, 200, `<polygon points="${pts.join(" ")}" fill="${fill}" stroke="#111827" stroke-width="6" stroke-linejoin="round"/><text x="100" y="${label.length > 4 ? 114 : 118}" text-anchor="middle" ${FONT} font-size="${label.length > 4 ? 38 : 50}" fill="${textFill}" stroke="#111827" stroke-width="2">${label}</text>`);
}

export const STICKERS: readonly Sticker[] = [
  // ---- Social ----
  { id: "subscribe", label: "Subscribe", category: "Social", markup: pill("SUBSCRIBE", "#dc2626", 380) },
  { id: "follow", label: "Follow", category: "Social", markup: pill("FOLLOW", "#7c3aed", 280) },
  { id: "like", label: "Like", category: "Social", markup: svg(120, 120, `<circle cx="60" cy="60" r="56" fill="#2563eb"/><path fill="#fff" d="M34 54h12v34H34zM50 88V54l14-22c3-4 10-2 10 4v14h14c5 0 9 5 8 10l-5 20c-1 5-5 8-10 8z"/>`) },
  { id: "bell", label: "Bell", category: "Social", markup: svg(120, 120, `<circle cx="60" cy="60" r="56" fill="#f59e0b"/><path fill="#fff" d="M60 26c-14 0-24 11-24 25v17l-8 10h64l-8-10V51c0-14-10-25-24-25z"/><circle cx="60" cy="88" r="8" fill="#fff"/>`) },
  { id: "share", label: "Share", category: "Social", markup: svg(120, 120, `<circle cx="60" cy="60" r="56" fill="#10b981"/><g fill="#fff"><circle cx="40" cy="60" r="11"/><circle cx="80" cy="38" r="11"/><circle cx="80" cy="82" r="11"/></g><path d="M40 60L80 38M40 60L80 82" stroke="#fff" stroke-width="7"/>`) },
  { id: "link-bio", label: "Link in bio", category: "Social", markup: pill("LINK IN BIO ↓", "#0f172a", 400) },
  // ---- Callouts ----
  { id: "new", label: "New", category: "Callouts", markup: burst("NEW", "#facc15", "#111827") },
  { id: "sale", label: "Sale", category: "Callouts", markup: burst("SALE", "#ef4444") },
  { id: "wow", label: "Wow", category: "Callouts", markup: burst("WOW!", "#ec4899") },
  { id: "free", label: "Free", category: "Callouts", markup: burst("FREE", "#22c55e") },
  { id: "tag", label: "Price tag", category: "Callouts", markup: svg(220, 120, `<path d="M8 60L48 10h160v100H48z" fill="#f97316" stroke="#111827" stroke-width="6" stroke-linejoin="round"/><circle cx="52" cy="60" r="10" fill="#fff" stroke="#111827" stroke-width="5"/><text x="130" y="76" text-anchor="middle" ${FONT} font-size="44" fill="#fff">-50%</text>`) },
  { id: "breaking", label: "Breaking", category: "Callouts", markup: svg(420, 90, `<rect width="420" height="90" fill="#111827"/><rect width="170" height="90" fill="#dc2626"/><text x="85" y="58" text-anchor="middle" ${FONT} font-size="30" fill="#fff">BREAKING</text><text x="295" y="58" text-anchor="middle" ${FONT} font-size="30" fill="#fff">NEWS</text>`) },
  // ---- Shapes & marks ----
  { id: "circle-mark", label: "Circle it", category: "Shapes & marks", markup: svg(220, 160, `<path d="M40 90c-10-40 40-70 90-66 50 4 80 34 70 64-10 34-70 52-120 42C40 122 18 96 34 70c10-16 34-28 60-32" fill="none" stroke="#ef4444" stroke-width="10" stroke-linecap="round"/>`) },
  { id: "underline", label: "Underline", category: "Shapes & marks", markup: svg(300, 60, `<path d="M10 36c60-14 120-18 180-12 34 4 66 10 100 4" fill="none" stroke="#facc15" stroke-width="14" stroke-linecap="round"/>`) },
  { id: "arrow-curved", label: "Curved arrow", category: "Shapes & marks", markup: svg(200, 160, `<path d="M20 140C30 70 80 34 150 36" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/><path d="M128 8l46 28-44 32" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`) },
  { id: "sparkle", label: "Sparkle", category: "Shapes & marks", markup: svg(120, 120, `<path fill="#fde047" d="M60 4c4 30 14 46 56 56-42 10-52 26-56 56-4-30-14-46-56-56 42-10 52-26 56-56z"/><path fill="#fff" d="M98 6c1 9 4 13 14 15-10 2-13 6-14 15-1-9-4-13-14-15 10-2 13-6 14-15z"/>`) },
  { id: "lightning", label: "Lightning", category: "Shapes & marks", markup: svg(100, 140, `<path d="M62 4L10 80h34l-10 56 56-82H54z" fill="#facc15" stroke="#111827" stroke-width="5" stroke-linejoin="round"/>`) },
  { id: "check", label: "Check", category: "Shapes & marks", markup: svg(120, 120, `<circle cx="60" cy="60" r="54" fill="#22c55e" stroke="#fff" stroke-width="6"/><path d="M34 62l18 18 36-40" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`) },
  { id: "cross", label: "Cross", category: "Shapes & marks", markup: svg(120, 120, `<circle cx="60" cy="60" r="54" fill="#ef4444" stroke="#fff" stroke-width="6"/><path d="M40 40l40 40M80 40L40 80" stroke="#fff" stroke-width="12" stroke-linecap="round"/>`) },
  // ---- Reactions ----
  { id: "fire", label: "Fire", category: "Reactions", markup: svg(120, 150, `<path d="M60 6c10 30 46 44 46 86a46 46 0 0 1-92 0c0-22 12-36 22-46 0 14 6 22 14 26C46 48 50 26 60 6z" fill="#f97316"/><path d="M60 70c6 14 24 20 24 40a24 24 0 0 1-48 0c0-12 8-20 14-24 0 8 4 12 8 14-2-12 0-20 2-30z" fill="#fde047"/>`) },
  { id: "hundred", label: "100", category: "Reactions", markup: svg(200, 130, `<text x="100" y="92" text-anchor="middle" ${FONT} font-size="84" font-style="italic" fill="#ef4444">100</text><path d="M30 106h140M40 120h120" stroke="#ef4444" stroke-width="8" stroke-linecap="round"/>`) },
  { id: "crown", label: "Crown", category: "Reactions", markup: svg(160, 120, `<path d="M14 100L6 30l40 30 34-46 34 46 40-30-8 70z" fill="#facc15" stroke="#a16207" stroke-width="6" stroke-linejoin="round"/><rect x="14" y="98" width="132" height="16" rx="4" fill="#eab308"/>`) },
  { id: "heart-burst", label: "Love", category: "Reactions", markup: svg(140, 130, `<path fill="#ec4899" d="M70 120L16 66a32 32 0 0 1 54-40 32 32 0 0 1 54 40z"/><path fill="#fff" opacity=".85" d="M38 44a14 14 0 0 1 18-8" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`) },
  { id: "speech-wow", label: "Speech", category: "Reactions", markup: svg(220, 170, `<path d="M20 20h180a12 12 0 0 1 12 12v86a12 12 0 0 1-12 12H90l-40 32 8-32H20a12 12 0 0 1-12-12V32a12 12 0 0 1 12-12z" fill="#fff" stroke="#111827" stroke-width="6" stroke-linejoin="round"/><text x="110" y="92" text-anchor="middle" ${FONT} font-size="44" fill="#111827">OMG!</text>`) },
];

export const STICKER_CATEGORIES = ["Social", "Callouts", "Shapes & marks", "Reactions"] as const;

/** Emoji added as text layers (drawn by the platform's color-emoji font, in preview and export alike). */
export const EMOJI_STICKERS = ["😂", "😍", "🔥", "👏", "🎉", "💯", "😮", "😎", "🙌", "❤️", "👀", "🤯", "✨", "🚀", "👇", "✅", "❌", "⭐", "🎬", "💡"];
