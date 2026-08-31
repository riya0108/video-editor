export type ToolCategory = "video" | "audio" | "speech";

export interface ToolDefinition {
  slug: string;
  category: ToolCategory;
  name: string;
  /** Short verb-first description shown on cards */
  description: string;
  /** Key into the icon map (src/lib/icon-map.tsx) */
  icon: string;
  /** Extra search terms beyond name/description */
  keywords?: string[];
  status: "available" | "soon";
  /** Marks flagship tools surfaced first on the homepage */
  featured?: boolean;
}

export const categoryMeta: Record<
  ToolCategory,
  { label: string; description: string; accent: "primary" | "accent" | "success" }
> = {
  video: {
    label: "Video Tools",
    description: "Edit, transform, and record video — right in your browser.",
    accent: "primary",
  },
  audio: {
    label: "Audio Tools",
    description: "Trim, tune, and clean up audio without installing anything.",
    accent: "accent",
  },
  speech: {
    label: "Speech",
    description: "Convert between text and speech — voiceovers and transcripts.",
    accent: "success",
  },
};

export const tools: ToolDefinition[] = [
  // ---- Video ----
  {
    slug: "video-editor",
    category: "video",
    name: "Video Editor",
    description: "Trim, resize for any platform, dub audio, animate text — with full undo/redo history.",
    icon: "clapperboard",
    keywords: ["timeline", "full editor", "dubbing", "aspect ratio", "resize", "undo", "redo", "version history", "animation", "gradient background"],
    status: "available",
    featured: true,
  },
  {
    slug: "trim-video",
    category: "video",
    name: "Trim Video",
    description: "Cut a video down to the exact part you need.",
    icon: "scissors",
    keywords: ["cut", "clip"],
    status: "available",
    featured: true,
  },
  {
    slug: "merge-videos",
    category: "video",
    name: "Merge Videos",
    description: "Combine multiple clips into a single video.",
    icon: "combine",
    keywords: ["join", "concat", "combine"],
    status: "available",
    featured: true,
  },
  {
    slug: "crop-video",
    category: "video",
    name: "Crop Video",
    description: "Cut out unwanted edges or change the frame.",
    icon: "crop",
    status: "available",
  },
  {
    slug: "rotate-video",
    category: "video",
    name: "Rotate Video",
    description: "Fix sideways or upside-down footage.",
    icon: "rotate-cw",
    status: "available",
  },
  {
    slug: "flip-video",
    category: "video",
    name: "Flip Video",
    description: "Mirror a video horizontally or vertically.",
    icon: "flip-horizontal",
    status: "available",
  },
  {
    slug: "resize-video",
    category: "video",
    name: "Resize Video",
    description: "Auto-fit Instagram, Facebook, WhatsApp, YouTube, and more — or a custom size.",
    icon: "maximize",
    keywords: ["dimensions", "aspect ratio", "instagram", "facebook", "youtube shorts", "whatsapp status", "banner", "profile photo"],
    status: "available",
  },
  {
    slug: "loop-video",
    category: "video",
    name: "Loop Video",
    description: "Repeat a clip to hit a target length.",
    icon: "repeat",
    status: "available",
  },
  {
    slug: "video-volume",
    category: "video",
    name: "Change Video Volume",
    description: "Turn audio up, down, or off entirely.",
    icon: "volume-2",
    status: "available",
  },
  {
    slug: "video-speed",
    category: "video",
    name: "Change Video Speed",
    description: "Slow footage down or speed it up.",
    icon: "gauge",
    keywords: ["slow motion", "timelapse", "fast"],
    status: "available",
  },
  {
    slug: "add-audio",
    category: "video",
    name: "Add Audio to Video",
    description: "Mix in music, or record/upload a dubbed voice track.",
    icon: "music",
    keywords: ["dubbing", "dub", "voiceover", "duck audio"],
    status: "available",
  },
  {
    slug: "add-image",
    category: "video",
    name: "Add Image to Video",
    description: "Place a logo, watermark, or photo on top.",
    icon: "image-plus",
    status: "available",
  },
  {
    slug: "add-text",
    category: "video",
    name: "Add Text to Video",
    description: "Add captions, titles, or lower-thirds — with automatic AI captions in any language.",
    icon: "type",
    keywords: ["captions", "subtitles", "titles", "auto captions", "speech to text", "srt", "vtt"],
    status: "available",
    featured: true,
  },
  {
    slug: "remove-logo",
    category: "video",
    name: "Remove Logo from Video",
    description: "Erase a watermark or logo in a region you choose, reconstructed from the surrounding video.",
    icon: "eraser",
    keywords: ["watermark removal", "delogo"],
    status: "available",
  },
  {
    slug: "remove-background",
    category: "video",
    name: "Remove Background from Video or Image",
    description: "Green-screen chroma key, or AI subject detection when you don't have a green screen at all.",
    icon: "layers",
    keywords: [
      "background removal",
      "green screen",
      "chroma key",
      "transparent background",
      "cutout",
      "no green screen",
      "background replace",
      "background blur",
    ],
    status: "available",
    featured: true,
  },
  {
    slug: "remove-passerby",
    category: "video",
    name: "Remove a Person from Video",
    description: "Erase someone walking through your shot, with an AI-assisted region tracker.",
    icon: "user-round-x",
    keywords: ["passerby", "object removal", "delogo", "remove person", "background"],
    status: "available",
  },
  {
    slug: "remove-filler-words",
    category: "video",
    name: "Remove Filler Words & Silences",
    description: "Auto-detect \"um\"s, \"uh\"s, and dead air, then cut them out.",
    icon: "wand-2",
    keywords: ["clean audio", "filler words", "remove silence", "um uh", "jump cuts"],
    status: "available",
    featured: true,
  },
  {
    slug: "upscale-media",
    category: "video",
    name: "Upscale Video or Image",
    description: "Increase resolution with sharpened, lanczos-resampled scaling.",
    icon: "sparkles",
    keywords: ["upscale", "enhance", "quality", "resolution", "4k", "1080p", "720p", "hd", "super resolution"],
    status: "available",
    featured: true,
  },
  {
    slug: "stabilize-video",
    category: "video",
    name: "Stabilize Video",
    description: "Smooth out shaky handheld footage.",
    icon: "anchor",
    status: "available",
  },
  {
    slug: "screen-recorder",
    category: "video",
    name: "Screen Recorder",
    description: "Capture your screen with one click, no install.",
    icon: "monitor-play",
    status: "available",
    featured: true,
  },
  {
    slug: "video-recorder",
    category: "video",
    name: "Video Recorder",
    description: "Record from your webcam straight to a file.",
    icon: "camera",
    status: "available",
  },

  // ---- Audio ----
  {
    slug: "trim-audio",
    category: "audio",
    name: "Trim Audio",
    description: "Cut an audio file down to the part you need.",
    icon: "scissors",
    status: "available",
    featured: true,
  },
  {
    slug: "audio-volume",
    category: "audio",
    name: "Change Volume",
    description: "Make an audio file louder, quieter, or normalized.",
    icon: "volume-2",
    status: "available",
  },
  {
    slug: "audio-speed",
    category: "audio",
    name: "Change Speed",
    description: "Speed up or slow down without changing pitch.",
    icon: "gauge",
    status: "available",
  },
  {
    slug: "audio-pitch",
    category: "audio",
    name: "Change Pitch",
    description: "Shift pitch up or down independent of speed.",
    icon: "music-2",
    status: "available",
  },
  {
    slug: "equalizer",
    category: "audio",
    name: "Equalizer",
    description: "Shape the sound with a 10-band graphic EQ.",
    icon: "sliders-horizontal",
    status: "available",
    featured: true,
  },
  {
    slug: "reverse-audio",
    category: "audio",
    name: "Reverse Audio",
    description: "Play a track backwards.",
    icon: "rewind",
    status: "available",
  },
  {
    slug: "voice-recorder",
    category: "audio",
    name: "Voice Recorder",
    description: "Record from your microphone straight to a file.",
    icon: "mic",
    status: "available",
    featured: true,
  },
  {
    slug: "audio-joiner",
    category: "audio",
    name: "Audio Joiner",
    description: "Stitch multiple audio files into one.",
    icon: "link-2",
    keywords: ["merge audio", "combine"],
    status: "available",
  },

  // ---- Speech ----
  {
    slug: "text-to-speech",
    category: "speech",
    name: "Text to Speech",
    description: "Turn written text into a natural voiceover.",
    icon: "message-square-text",
    keywords: ["tts", "voiceover", "narration"],
    status: "available",
    featured: true,
  },
  {
    slug: "transcribe",
    category: "speech",
    name: "Video Transcript",
    description: "Get a text transcript from an uploaded file or a YouTube, Instagram, or TikTok link.",
    icon: "file-text",
    keywords: ["transcription", "speech to text", "subtitles", "youtube", "instagram", "tiktok", "captions", "whisper"],
    status: "available",
    featured: true,
  },
];

export function getToolPath(tool: Pick<ToolDefinition, "category" | "slug">) {
  return `/tools/${tool.category}/${tool.slug}`;
}

export function getToolBySlug(category: string, slug: string) {
  return tools.find((t) => t.category === category && t.slug === slug);
}
