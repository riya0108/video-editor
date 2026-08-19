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
  {
    id: "poppins",
    label: "Rounded",
    ffmpegName: "poppins.ttf",
    url: "/fonts/poppins-drawtext.ttf",
    cssFontFamily: '"Poppins", ui-sans-serif, sans-serif',
  },
  {
    id: "playfair",
    label: "Elegant Serif",
    ffmpegName: "playfair.ttf",
    url: "/fonts/playfair-drawtext.ttf",
    cssFontFamily: '"Playfair Display", ui-serif, serif',
  },
  {
    id: "caveat",
    label: "Handwriting",
    ffmpegName: "caveat.ttf",
    url: "/fonts/caveat-drawtext.ttf",
    cssFontFamily: '"Caveat", cursive',
  },
  {
    id: "oswald",
    label: "Condensed",
    ffmpegName: "oswald.ttf",
    url: "/fonts/oswald-drawtext.ttf",
    cssFontFamily: '"Oswald", ui-sans-serif, sans-serif',
  },
  {
    id: "marker",
    label: "Marker",
    ffmpegName: "permanent-marker.ttf",
    url: "/fonts/permanent-marker-drawtext.ttf",
    cssFontFamily: '"Permanent Marker", cursive',
  },
  {
    id: "archivo-black",
    label: "Heavy Block",
    ffmpegName: "archivo-black.ttf",
    url: "/fonts/archivo-black-drawtext.ttf",
    cssFontFamily: '"Archivo Black", ui-sans-serif, sans-serif',
  },
  {
    id: "bangers",
    label: "Comic",
    ffmpegName: "bangers.ttf",
    url: "/fonts/bangers-drawtext.ttf",
    cssFontFamily: '"Bangers", cursive',
  },
  {
    id: "pacifico",
    label: "Script",
    ffmpegName: "pacifico.ttf",
    url: "/fonts/pacifico-drawtext.ttf",
    cssFontFamily: '"Pacifico", cursive',
  },
  {
    id: "righteous",
    label: "Rounded Display",
    ffmpegName: "righteous.ttf",
    url: "/fonts/righteous-drawtext.ttf",
    cssFontFamily: '"Righteous", ui-sans-serif, sans-serif',
  },
  {
    id: "bungee",
    label: "Urban Block",
    ffmpegName: "bungee.ttf",
    url: "/fonts/bungee-drawtext.ttf",
    cssFontFamily: '"Bungee", ui-sans-serif, sans-serif',
  },
  {
    id: "dancing-script",
    label: "Elegant Script",
    ffmpegName: "dancing-script.ttf",
    url: "/fonts/dancing-script-drawtext.ttf",
    cssFontFamily: '"Dancing Script", cursive',
  },
  {
    id: "roboto-slab",
    label: "Slab Serif",
    ffmpegName: "roboto-slab.ttf",
    url: "/fonts/roboto-slab-drawtext.ttf",
    cssFontFamily: '"Roboto Slab", ui-serif, serif',
  },
  {
    id: "montserrat",
    label: "Modern",
    ffmpegName: "montserrat.ttf",
    url: "/fonts/montserrat-drawtext.ttf",
    cssFontFamily: '"Montserrat", ui-sans-serif, sans-serif',
  },
  {
    id: "great-vibes",
    label: "Calligraphy",
    ffmpegName: "great-vibes.ttf",
    url: "/fonts/great-vibes-drawtext.ttf",
    cssFontFamily: '"Great Vibes", cursive',
  },
];

export const DEFAULT_TEXT_FONT = TEXT_FONTS[0];

export function getTextFont(id: string): TextFontOption {
  return TEXT_FONTS.find((f) => f.id === id) ?? DEFAULT_TEXT_FONT;
}
