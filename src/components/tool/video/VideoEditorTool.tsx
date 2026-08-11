import { useState } from "react";
import {
  Play,
  Pause,
  Type,
  Music,
  Download,
  Crop as CropIcon,
  Gauge,
  Palette,
  MicOff,
  Wind,
  Eraser,
  ImageIcon,
  Layers,
  Film,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import EditorSection from "./editor/EditorSection";
import ChromaKeyPanel from "./editor/ChromaKeyPanel";
import OverlayLayersPanel from "./editor/OverlayLayersPanel";
import PickColorOverlay from "./editor/PickColorOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { stripExtension } from "../../../lib/ffmpeg/format";
import { formatTime } from "../../../lib/time";
import { sampleVideoColor } from "../../../lib/sample-video-color";
import { buildEditorCommand } from "../../../lib/ffmpeg/build-editor-command";
import { TEXT_FONTS } from "../../../lib/ffmpeg/fonts";
import { anchorExpr } from "../../../lib/ffmpeg/overlay-position";
import type { OverlayLayer } from "../../../lib/ffmpeg/overlay-layer";
import type {
  EditorChromaKeyState,
  EditorCropState,
  EditorLogoState,
  EditorBgBlurState,
  EditorMusicState,
  EditorExtraClipState,
  EditorTextState,
  EditorFadeState,
  BgAspect,
  TextPosition,
  TextAnimation,
} from "../../../lib/ffmpeg/editor-state";

const DEFAULT_CROP_RECT: FractionRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
const DEFAULT_LOGO_RECT: FractionRect = { x: 0.72, y: 0.06, w: 0.22, h: 0.14 };

const TEXT_POSITION_CLASS: Record<TextPosition, string> = {
  top: "items-start pt-[6%]",
  center: "items-center",
  bottom: "items-end pb-[6%]",
};
const TEXT_COLORS = [
  "#ffffff",
  "#000000",
  "#facc15",
  "#ef4444",
  "#22c55e",
  "#38bdf8",
];
const BG_ASPECTS: { id: BgAspect; label: string }[] = [
  { id: "9:16", label: "9:16 Reels/Story" },
  { id: "1:1", label: "1:1 Square" },
  { id: "4:5", label: "4:5 Portrait" },
  { id: "16:9", label: "16:9 Landscape" },
];

export default function VideoEditorTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();

  // Trim + playback
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Feature panels
  const [crop, setCrop] = useState<EditorCropState>({
    enabled: false,
    rect: DEFAULT_CROP_RECT,
  });
  const [speedFadeOpen, setSpeedFadeOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fade, setFade] = useState<EditorFadeState>({ in: 0, out: 0 });
  const [chromaKey, setChromaKey] = useState<EditorChromaKeyState>({
    enabled: false,
    colorHex: "#00ff00",
    similarity: 0.2,
    blend: 0.1,
    replace: "color",
    replaceColorHex: "#000000",
    replaceImageFile: null,
    replaceVideoFile: null,
  });
  const [pickingColor, setPickingColor] = useState(false);
  const [voiceRemover, setVoiceRemover] = useState(false);
  const [noise, setNoise] = useState({ enabled: false, strength: 12 });
  const [logo, setLogo] = useState<EditorLogoState>({
    enabled: false,
    rect: DEFAULT_LOGO_RECT,
  });
  const [bgBlur, setBgBlur] = useState<EditorBgBlurState>({
    enabled: false,
    aspect: "9:16",
  });
  const [music, setMusic] = useState<EditorMusicState>({
    enabled: false,
    file: null,
    mode: "mix",
  });
  const [extraClip, setExtraClip] = useState<EditorExtraClipState>({
    enabled: false,
    file: null,
    kind: "video",
    position: "after",
    imageDuration: 3,
  });
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const [overlays, setOverlays] = useState<OverlayLayer[]>([]);
  const [text, setText] = useState<EditorTextState>({
    enabled: false,
    content: "Your text here",
    color: "#ffffff",
    fontSize: 56,
    position: "bottom",
    fontId: "geist",
    animation: "none",
  });

  const handleLoadedMetadata = () => {
    video.onLoadedMetadata();
    const d = video.videoRef.current?.duration || 0;
    setStart(0);
    setEnd(d);
  };

  const clampToRange = (t: number) => Math.min(end, Math.max(start, t));

  const togglePlay = () => {
    const el = video.videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.currentTime = clampToRange(el.currentTime);
      el.play();
    } else {
      el.pause();
    }
  };

  const seekTo = (t: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    el.currentTime = clampToRange(t);
    setCurrentTime(el.currentTime);
  };

  const handleTimeUpdate = () => {
    const el = video.videoRef.current;
    if (!el) return;
    setCurrentTime(el.currentTime);
    if (el.currentTime >= end) el.pause();
  };

  const trimmedDuration = Math.max(0, end - start);

  const handlePickColor = (fx: number, fy: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    setChromaKey((s) => ({ ...s, colorHex: sampleVideoColor(el, fx, fy) }));
    setPickingColor(false);
  };

  const handleExport = async () => {
    if (!video.file || trimmedDuration <= 0) return;

    const { inputs, args, outputName } = await buildEditorCommand({
      videoFile: video.file,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      trimStart: start,
      trimEnd: end,
      crop,
      logo,
      chromaKey,
      bgBlur,
      speed,
      fade,
      voiceRemover,
      noise,
      music,
      overlays,
      extraClip,
      text,
    });

    await exportState.run(
      { inputs, args, outputName, outputMimeType: "video/mp4" },
      `edited-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setCrop({ enabled: false, rect: DEFAULT_CROP_RECT });
    setSpeedFadeOpen(false);
    setSpeed(1);
    setFade({ in: 0, out: 0 });
    setChromaKey((s) => ({ ...s, enabled: false }));
    setVoiceRemover(false);
    setNoise({ enabled: false, strength: 12 });
    setLogo({ enabled: false, rect: DEFAULT_LOGO_RECT });
    setBgBlur({ enabled: false, aspect: "9:16" });
    setMusic({ enabled: false, file: null, mode: "mix" });
    setExtraClip({
      enabled: false,
      file: null,
      kind: "video",
      position: "after",
      imageDuration: 3,
    });
    setOverlaysOpen(false);
    setOverlays([]);
    setText({
      enabled: false,
      content: "Your text here",
      color: "#ffffff",
      fontSize: 56,
      position: "bottom",
      fontId: "geist",
      animation: "none",
    });
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Trim, crop, key out a color, layer in text and overlays — then export in one pass"
        onFiles={video.handleFiles}
      />
    );
  }

  if (exportState.result) {
    return (
      <ResultPanel
        url={exportState.result.url}
        blob={exportState.result.blob}
        filename={exportState.result.filename}
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr] lg:items-start">
      <div className="space-y-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
        <EditorSection
          icon={CropIcon}
          label="Crop"
          enabled={crop.enabled}
          onToggle={(enabled) => setCrop((s) => ({ ...s, enabled }))}
        >
          <p className="text-caption text-(--color-text-muted)">
            Drag the box over the preview to choose what stays in frame.
          </p>
        </EditorSection>

        <EditorSection
          icon={Gauge}
          label="Speed & fade"
          enabled={speedFadeOpen}
          onToggle={(enabled) => {
            setSpeedFadeOpen(enabled);
            if (!enabled) {
              setSpeed(1);
              setFade({ in: 0, out: 0 });
            }
          }}
        >
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
              Speed
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="flex-1 accent-(--color-primary-500)"
              />
              <span className="w-12 text-right tabular-nums">
                {speed.toFixed(2)}x
              </span>
            </label>
            <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
              Fade in
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={fade.in}
                onChange={(e) =>
                  setFade((s) => ({ ...s, in: Number(e.target.value) }))
                }
                className="flex-1 accent-(--color-primary-500)"
              />
              <span className="w-12 text-right tabular-nums">
                {fade.in.toFixed(1)}s
              </span>
            </label>
            <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
              Fade out
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={fade.out}
                onChange={(e) =>
                  setFade((s) => ({ ...s, out: Number(e.target.value) }))
                }
                className="flex-1 accent-(--color-primary-500)"
              />
              <span className="w-12 text-right tabular-nums">
                {fade.out.toFixed(1)}s
              </span>
            </label>
          </div>
        </EditorSection>

        <EditorSection
          icon={Palette}
          label="Remove a color / green screen"
          enabled={chromaKey.enabled}
          onToggle={(enabled) => setChromaKey((s) => ({ ...s, enabled }))}
        >
          <ChromaKeyPanel
            state={chromaKey}
            onChange={(patch) => setChromaKey((s) => ({ ...s, ...patch }))}
            picking={pickingColor}
            onTogglePicking={() => setPickingColor((p) => !p)}
          />
        </EditorSection>

        <EditorSection
          icon={Eraser}
          label="Remove logo"
          enabled={logo.enabled}
          onToggle={(enabled) => setLogo((s) => ({ ...s, enabled }))}
        >
          <p className="text-caption text-(--color-text-muted)">
            Drag the red box over the logo or watermark in the preview.
          </p>
        </EditorSection>

        <EditorSection
          icon={MicOff}
          label="Remove voice"
          enabled={voiceRemover}
          onToggle={setVoiceRemover}
        >
          <p className="text-caption text-(--color-text-muted)">
            Best-effort: cancels audio that's identical in both stereo channels
            (usually lead vocals). Works better on some mixes than others, and
            has no effect on mono audio.
          </p>
        </EditorSection>

        <EditorSection
          icon={Wind}
          label="Reduce background noise"
          enabled={noise.enabled}
          onToggle={(enabled) => setNoise((s) => ({ ...s, enabled }))}
        >
          <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
            Strength
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={noise.strength}
              onChange={(e) =>
                setNoise((s) => ({ ...s, strength: Number(e.target.value) }))
              }
              className="flex-1 accent-(--color-primary-500)"
            />
            <span className="w-10 text-right tabular-nums">
              {noise.strength}
            </span>
          </label>
        </EditorSection>

        <EditorSection
          icon={ImageIcon}
          label="Blurred background padding"
          enabled={bgBlur.enabled}
          onToggle={(enabled) => setBgBlur((s) => ({ ...s, enabled }))}
        >
          <div className="flex flex-wrap gap-2">
            {BG_ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setBgBlur((s) => ({ ...s, aspect: a.id }))}
                className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${bgBlur.aspect === a.id ? "border-primary-500 bg-primary-500 text-white" : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"}`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-caption text-(--color-text-muted)">
            Fits your video onto that canvas with a blurred, zoomed copy of
            itself filling the empty space — no black bars.
          </p>
        </EditorSection>

        <EditorSection
          icon={Type}
          label="Add text"
          enabled={text.enabled}
          onToggle={(enabled) => setText((s) => ({ ...s, enabled }))}
        >
          <div className="space-y-3">
            <textarea
              value={text.content}
              onChange={(e) =>
                setText((s) => ({ ...s, content: e.target.value }))
              }
              rows={2}
              placeholder="Type your text…"
              className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
            />
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Text color ${c}`}
                    onClick={() => setText((s) => ({ ...s, color: c }))}
                    className={`h-6 w-6 rounded-full border-2 ${text.color === c ? "border-primary-500" : "border-(--color-border)"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                {(["top", "center", "bottom"] as TextPosition[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setText((s) => ({ ...s, position: p }))}
                    className={`rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${text.position === p ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                Size
                <input
                  type="range"
                  min={16}
                  max={140}
                  value={text.fontSize}
                  onChange={(e) =>
                    setText((s) => ({ ...s, fontSize: Number(e.target.value) }))
                  }
                  className="w-24 accent-(--color-primary-500)"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                {TEXT_FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setText((s) => ({ ...s, fontId: f.id }))}
                    className={`rounded px-3 py-1 text-caption font-medium transition-colors ${text.fontId === f.id ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                    style={{ fontFamily: f.cssFontFamily }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                {(
                  [
                    { id: "none", label: "None" },
                    { id: "fade", label: "Fade" },
                    { id: "slide-up", label: "Slide up" },
                    { id: "slide-down", label: "Slide down" },
                  ] as { id: TextAnimation; label: string }[]
                ).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setText((s) => ({ ...s, animation: a.id }))}
                    className={`rounded px-3 py-1 text-caption font-medium transition-colors ${text.animation === a.id ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </EditorSection>

        <EditorSection
          icon={Layers}
          label="Overlays: pictures, video, stickers"
          enabled={overlaysOpen}
          onToggle={(enabled) => {
            setOverlaysOpen(enabled);
            if (!enabled) setOverlays([]);
          }}
        >
          <OverlayLayersPanel
            layers={overlays}
            onAdd={(layer) => setOverlays((o) => [...o, layer])}
            onUpdate={(id, patch) =>
              setOverlays((o) =>
                o.map((l) => (l.id === id ? { ...l, ...patch } : l)),
              )
            }
            onRemove={(id) => setOverlays((o) => o.filter((l) => l.id !== id))}
            duration={trimmedDuration}
          />
        </EditorSection>

        <EditorSection
          icon={Music}
          label="Add music"
          enabled={music.enabled}
          onToggle={(enabled) => setMusic((s) => ({ ...s, enabled }))}
        >
          {!music.file ? (
            <Dropzone
              accept="audio/*"
              label="Drop a music file here"
              hint="MP3, WAV, M4A, and more"
              onFiles={(files) =>
                setMusic((s) => ({ ...s, file: files[0] ?? null }))
              }
            />
          ) : (
            <div className="space-y-3">
              <p className="text-body-sm text-(--color-text-muted)">
                {music.file.name}
              </p>
              <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                <button
                  type="button"
                  onClick={() => setMusic((s) => ({ ...s, mode: "mix" }))}
                  className={`rounded px-3 py-1 text-caption font-medium transition-colors ${music.mode === "mix" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                >
                  Mix with original
                </button>
                <button
                  type="button"
                  onClick={() => setMusic((s) => ({ ...s, mode: "replace" }))}
                  className={`rounded px-3 py-1 text-caption font-medium transition-colors ${music.mode === "replace" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                >
                  Replace original
                </button>
              </div>
            </div>
          )}
        </EditorSection>

        <EditorSection
          icon={Film}
          label="Add intro/outro clip"
          enabled={extraClip.enabled}
          onToggle={(enabled) => setExtraClip((s) => ({ ...s, enabled }))}
        >
          {!extraClip.file ? (
            <Dropzone
              accept="video/*,image/*"
              label="Drop an image or video here"
              hint="Extends the total length of your export"
              onFiles={(files) => {
                const file = files[0];
                if (!file) return;
                setExtraClip((s) => ({
                  ...s,
                  file,
                  kind: file.type.startsWith("image/") ? "image" : "video",
                }));
              }}
            />
          ) : (
            <div className="space-y-3">
              <p className="text-body-sm text-(--color-text-muted)">
                {extraClip.file.name}
              </p>
              <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                <button
                  type="button"
                  onClick={() =>
                    setExtraClip((s) => ({ ...s, position: "before" }))
                  }
                  className={`rounded px-3 py-1 text-caption font-medium transition-colors ${extraClip.position === "before" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                >
                  Play before (intro)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExtraClip((s) => ({ ...s, position: "after" }))
                  }
                  className={`rounded px-3 py-1 text-caption font-medium transition-colors ${extraClip.position === "after" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                >
                  Play after (outro)
                </button>
              </div>
              {extraClip.kind === "image" && (
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Show for
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={0.5}
                    value={extraClip.imageDuration}
                    onChange={(e) =>
                      setExtraClip((s) => ({
                        ...s,
                        imageDuration: Number(e.target.value),
                      }))
                    }
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-12 text-right tabular-nums">
                    {extraClip.imageDuration}s
                  </span>
                </label>
              )}
            </div>
          )}
        </EditorSection>
      </div>

      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 lg:sticky lg:top-20">
        {video.sourceUrl && (
          <FramedVideoStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            naturalWidth={video.videoWidth}
            naturalHeight={video.videoHeight}
            onLoadedMetadata={handleLoadedMetadata}
            onError={video.onError}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          >
            {(box) => {
              const scale =
                video.videoWidth > 0 ? box.width / video.videoWidth : 1;
              return (
                <>
                  {pickingColor && (
                    <PickColorOverlay onPick={handlePickColor} />
                  )}

                  {!pickingColor && crop.enabled && (
                    <RectOverlay
                      boxWidth={box.width}
                      boxHeight={box.height}
                      rect={crop.rect}
                      onChange={(rect) => setCrop((s) => ({ ...s, rect }))}
                    />
                  )}
                  {!pickingColor && logo.enabled && (
                    <RectOverlay
                      boxWidth={box.width}
                      boxHeight={box.height}
                      rect={logo.rect}
                      onChange={(rect) => setLogo((s) => ({ ...s, rect }))}
                      color="danger"
                      minFraction={0.03}
                    />
                  )}

                  {!pickingColor &&
                    overlays.map((layer) => {
                      const { justify, align } = anchorExpr(layer.anchor);
                      return (
                        <div
                          key={layer.id}
                          className="pointer-events-none absolute inset-0 flex p-4"
                          style={{
                            justifyContent:
                              justify === "start"
                                ? "flex-start"
                                : justify === "end"
                                  ? "flex-end"
                                  : "center",
                            alignItems:
                              align === "start"
                                ? "flex-start"
                                : align === "end"
                                  ? "flex-end"
                                  : "center",
                          }}
                        >
                          {layer.kind === "image" ? (
                            <img
                              src={layer.previewUrl}
                              alt=""
                              style={{
                                width: box.width * (layer.sizePercent / 100),
                                opacity: layer.opacity,
                              }}
                              className="max-w-none"
                            />
                          ) : (
                            <video
                              src={layer.previewUrl}
                              muted
                              style={{
                                width: box.width * (layer.sizePercent / 100),
                                opacity: layer.opacity,
                              }}
                              className="max-w-none"
                            />
                          )}
                        </div>
                      );
                    })}

                  {!pickingColor && text.enabled && (
                    <div
                      className={`flex h-full w-full justify-center px-4 text-center ${TEXT_POSITION_CLASS[text.position]}`}
                    >
                      <span
                        className="max-w-full whitespace-pre-wrap break-words font-semibold"
                        style={{
                          fontSize: text.fontSize * scale,
                          color: text.color,
                          lineHeight: 1.1,
                          padding: `${8 * scale}px ${16 * scale}px`,
                          backgroundColor: "rgba(0,0,0,0.45)",
                          fontFamily: TEXT_FONTS.find(
                            (f) => f.id === text.fontId,
                          )?.cssFontFamily,
                        }}
                      >
                        {text.content || " "}
                      </span>
                    </div>
                  )}
                </>
              );
            }}
          </FramedVideoStage>
        )}

        <div className="mt-4 flex items-center gap-4">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
          >
            {isPlaying ? (
              <Pause size={18} />
            ) : (
              <Play size={18} className="ml-0.5" />
            )}
          </button>
          <div className="flex-1">
            <TrimSlider
              duration={video.duration}
              start={start}
              end={end}
              currentTime={currentTime}
              onChangeStart={setStart}
              onChangeEnd={setEnd}
              onSeek={seekTo}
            />
            <div className="flex justify-between text-caption tabular-nums text-(--color-text-muted)">
              <span>{formatTime(start, true)}</span>
              <span>Selected: {formatTime(trimmedDuration)}</span>
              <span>{formatTime(end, true)}</span>
            </div>
          </div>
        </div>

        <ExportStatus
          enginePhase={exportState.enginePhase}
          engineFraction={exportState.engineFraction}
          runFraction={exportState.runFraction}
          error={exportState.error ?? video.metadataError}
          runLabel="Exporting your edit…"
        />

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={
              exportState.isProcessing ||
              trimmedDuration <= 0 ||
              video.isMetadataLoading ||
              !!video.metadataError
            }
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={16} />
            {exportState.isProcessing
              ? "Exporting…"
              : video.isMetadataLoading
                ? "Reading video…"
                : "Export video"}
          </button>
        </div>
      </div>
    </div>
  );
}
