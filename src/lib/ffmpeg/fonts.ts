export interface TextFontOption {
  id: string;
  label: string;
  /** ffmpeg virtual-FS filename the ttf gets staged as. */
  ffmpegName: string;
  /** Public URL to fetch the ttf from. */
  url: string;
  /** CSS font-family for the live browser preview. */
  cssFontFamily: string;
}

export const TEXT_FONTS: TextFontOption[] = [
  {
    id: "geist",
    label: "Sans",
    ffmpegName: "geist.ttf",
    url: "/fonts/geist-drawtext.ttf",
    cssFontFamily: '"Geist Variable", ui-sans-serif, sans-serif',
  },
  {
    id: "bebas",
    label: "Bold display",
    ffmpegName: "bebas.ttf",
    url: "/fonts/bebas-neue-drawtext.ttf",
    cssFontFamily: '"Bebas Neue", ui-sans-serif, sans-serif',
  },
  {
    id: "mono",
    label: "Mono",
    ffmpegName: "geist-mono.ttf",
    url: "/fonts/geist-mono-drawtext.ttf",
    cssFontFamily: '"Geist Mono Variable", ui-monospace, monospace',
  },
  {
    id: "anton",
    label: "Impact",
    ffmpegName: "anton.ttf",
    url: "/fonts/anton-drawtext.ttf",
    cssFontFamily: '"Anton", ui-sans-serif, sans-serif',
  },
];

export const DEFAULT_TEXT_FONT = TEXT_FONTS[0];

export function getTextFont(id: string): TextFontOption {
  return TEXT_FONTS.find((f) => f.id === id) ?? DEFAULT_TEXT_FONT;
}
