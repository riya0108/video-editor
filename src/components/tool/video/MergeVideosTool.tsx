import { useState } from "react";
import { Combine, ChevronUp, ChevronDown, X } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension } from "../../../lib/ffmpeg/format";
import { readVideoMetadata } from "../../../lib/video-metadata";
import { evenRound } from "../../../lib/geometry";
import { formatTime } from "../../../lib/time";

interface Clip {
  id: string;
  file: File;
  width: number;
  height: number;
  duration: number;
  loading: boolean;
}

let clipIdCounter = 0;

export default function MergeVideosTool() {
  const exportState = useFfmpegExport();
  const [clips, setClips] = useState<Clip[]>([]);

  const addFiles = (files: File[]) => {
    const newClips: Clip[] = files.map((file) => ({
      id: `clip-${clipIdCounter++}`,
      file,
      width: 0,
      height: 0,
      duration: 0,
      loading: true,
    }));
    setClips((prev) => [...prev, ...newClips]);

    for (const clip of newClips) {
      readVideoMetadata(clip.file)
        .then(({ width, height, duration }) => {
          setClips((prev) =>
            prev.map((c) => (c.id === clip.id ? { ...c, width, height, duration, loading: false } : c)),
          );
        })
        .catch(() => {
          setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, loading: false } : c)));
        });
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    setClips((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeClip = (id: string) => setClips((prev) => prev.filter((c) => c.id !== id));

  const handleExport = async () => {
    if (clips.length < 2) return;
    const target = clips[0];
    const w = evenRound(target.width || 1280);
    const h = evenRound(target.height || 720);

    const inputs = clips.map((clip, i) => ({
      name: `clip${i}.${guessVideoExtension(clip.file)}`,
      data: clip.file,
    }));

    const chains: string[] = [];
    const labels: string[] = [];
    clips.forEach((_, i) => {
      chains.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`,
      );
      chains.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    const filterComplex = `${chains.join(";")};${labels.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`;

    const args: string[] = [];
    inputs.forEach((input) => args.push("-i", input.name));
    args.push(
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "output.mp4",
    );

    await exportState.run(
      { inputs, args, outputName: "output.mp4", outputMimeType: "video/mp4" },
      "merged.mp4",
    );
  };

  const reset = () => {
    exportState.reset();
    setClips([]);
  };

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
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      {clips.length === 0 ? (
        <Dropzone
          accept="video/*"
          multiple
          label="Drop two or more videos here, or click to browse"
          hint="They'll be joined in the order you add them — reorder anytime below"
          onFiles={addFiles}
        />
      ) : (
        <div className="space-y-2">
          {clips.map((clip, i) => (
            <div
              key={clip.id}
              className="flex items-center gap-3 rounded-lg border border-(--color-border) px-3 py-2.5"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-bg-subtle) text-caption font-semibold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-sm font-medium">{clip.file.name}</p>
                <p className="text-caption text-(--color-text-muted)">
                  {clip.loading ? "Reading…" : `${formatTime(clip.duration)} · ${clip.width}×${clip.height}`}
                </p>
              </div>
              <button
                type="button"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className="grid h-7 w-7 place-items-center rounded hover:bg-(--color-bg-subtle) disabled:opacity-30"
              >
                <ChevronUp size={15} />
              </button>
              <button
                type="button"
                aria-label="Move down"
                disabled={i === clips.length - 1}
                onClick={() => move(i, 1)}
                className="grid h-7 w-7 place-items-center rounded hover:bg-(--color-bg-subtle) disabled:opacity-30"
              >
                <ChevronDown size={15} />
              </button>
              <button
                type="button"
                aria-label="Remove"
                onClick={() => removeClip(clip.id)}
                className="grid h-7 w-7 place-items-center rounded text-danger-600 hover:bg-danger-500/10"
              >
                <X size={15} />
              </button>
            </div>
          ))}

          <Dropzone
            accept="video/*"
            multiple
            label="Add another video"
            hint="Drop more files, or click to browse"
            onFiles={addFiles}
          />
        </div>
      )}

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Merging videos…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || clips.length < 2 || clips.some((c) => c.loading)}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Combine size={16} />
          {exportState.isProcessing ? "Merging…" : `Merge ${clips.length || ""} videos`}
        </button>
      </div>
    </div>
  );
}
