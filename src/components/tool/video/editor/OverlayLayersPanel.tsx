import { useState } from "react";
import { ImagePlus, Film, Smile, X } from "lucide-react";
import EmojiPicker from "./EmojiPicker";
import { ANCHORS, type Anchor } from "../../../../lib/ffmpeg/overlay-position";
import { nextOverlayId, type OverlayLayer } from "../../../../lib/ffmpeg/overlay-layer";
import { renderEmojiToPng } from "../../../../lib/emoji-render";
import { formatTime } from "../../../../lib/time";

type AddMode = null | "emoji";

export default function OverlayLayersPanel({
  layers,
  onAdd,
  onUpdate,
  onRemove,
  duration,
}: {
  layers: OverlayLayer[];
  onAdd: (layer: OverlayLayer) => void;
  onUpdate: (id: string, patch: Partial<OverlayLayer>) => void;
  onRemove: (id: string) => void;
  duration: number;
}) {
  const [addMode, setAddMode] = useState<AddMode>(null);

  const addFile = (files: File[], kind: "image" | "video") => {
    const file = files[0];
    if (!file) return;
    onAdd({
      id: nextOverlayId(),
      kind,
      file,
      previewUrl: URL.createObjectURL(file),
      label: file.name,
      anchor: "center",
      sizePercent: kind === "image" ? 25 : 35,
      opacity: 1,
      start: 0,
      end: duration || 5,
    });
  };

  const addEmoji = async (emoji: string) => {
    const blob = await renderEmojiToPng(emoji);
    onAdd({
      id: nextOverlayId(),
      kind: "image",
      file: blob,
      previewUrl: URL.createObjectURL(blob),
      label: emoji,
      anchor: "center",
      sizePercent: 15,
      opacity: 1,
      start: 0,
      end: duration || 5,
    });
    setAddMode(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
          <ImagePlus size={14} />
          Add image
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => e.target.files && addFile(Array.from(e.target.files), "image")}
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
          <Film size={14} />
          Add video or GIF
          <input
            type="file"
            accept="video/*,image/gif"
            className="sr-only"
            onChange={(e) => e.target.files && addFile(Array.from(e.target.files), "video")}
          />
        </label>
        <button
          type="button"
          onClick={() => setAddMode(addMode === "emoji" ? null : "emoji")}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
            addMode === "emoji"
              ? "border-primary-500 bg-primary-500 text-white"
              : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
          }`}
        >
          <Smile size={14} />
          Add sticker
        </button>
      </div>

      {addMode === "emoji" && <EmojiPicker onPick={addEmoji} />}

      {layers.length > 0 && (
        <div className="space-y-3">
          {layers.map((layer) => (
            <div key={layer.id} className="rounded-lg border border-(--color-border) p-3">
              <div className="flex items-center gap-3">
                {layer.kind === "image" ? (
                  <img src={layer.previewUrl} alt="" className="h-10 w-10 rounded object-contain" />
                ) : (
                  <video src={layer.previewUrl} muted className="h-10 w-10 rounded object-cover" />
                )}
                <p className="min-w-0 flex-1 truncate text-body-sm font-medium">{layer.label}</p>
                <button
                  type="button"
                  aria-label={`Remove ${layer.label}`}
                  onClick={() => onRemove(layer.id)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded text-danger-600 hover:bg-danger-500/10"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4">
                <div className="grid grid-cols-3 gap-1">
                  {ANCHORS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      aria-label={a.id}
                      onClick={() => onUpdate(layer.id, { anchor: a.id as Anchor })}
                      className={`grid h-6 w-6 place-items-center rounded text-caption ${
                        layer.anchor === a.id
                          ? "bg-primary-500 text-white"
                          : "border border-(--color-border) hover:border-(--color-border-strong)"
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                  Size
                  <input
                    type="range"
                    min={5}
                    max={80}
                    value={layer.sizePercent}
                    onChange={(e) => onUpdate(layer.id, { sizePercent: Number(e.target.value) })}
                    className="w-20 accent-(--color-primary-500)"
                  />
                </label>
                <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                  Opacity
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={layer.opacity}
                    onChange={(e) => onUpdate(layer.id, { opacity: Number(e.target.value) })}
                    className="w-20 accent-(--color-primary-500)"
                  />
                </label>
              </div>

              <div className="mt-3 flex items-center gap-3 text-caption text-(--color-text-muted)">
                <span>Show from</span>
                <input
                  type="number"
                  min={0}
                  max={duration || undefined}
                  step={0.1}
                  value={layer.start.toFixed(1)}
                  onChange={(e) => onUpdate(layer.id, { start: Number(e.target.value) })}
                  className="w-16 rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1"
                />
                <span>to</span>
                <input
                  type="number"
                  min={0}
                  max={duration || undefined}
                  step={0.1}
                  value={layer.end.toFixed(1)}
                  onChange={(e) => onUpdate(layer.id, { end: Number(e.target.value) })}
                  className="w-16 rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1"
                />
                <span>({formatTime(Math.max(0, layer.end - layer.start))} shown)</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
