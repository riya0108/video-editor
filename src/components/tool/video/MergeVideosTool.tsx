import { useEffect, useRef, useState } from "react";
import { Combine, ChevronUp, ChevronDown, X, Scissors } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension } from "../../../lib/ffmpeg/format";
import { readVideoMetadata } from "../../../lib/video-metadata";
import { probeHasAudio } from "../../../lib/ffmpeg/engine";
import { evenRound } from "../../../lib/geometry";
import { formatTime, toFfmpegTimestamp } from "../../../lib/time";
import { createSilentWav } from "../../../lib/wav";

interface Clip {
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  loading: boolean;
  trimStart: number;
  trimEnd: number;
  expanded: boolean;
}

let clipIdCounter = 0;

export default function MergeVideosTool() {
  const exportState = useFfmpegExport();
  const [clips, setClips] = useState<Clip[]>([]);
  const [currentTimes, setCurrentTimes] = useState<Record<string, number>>({});
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const clipsRef = useRef<Clip[]>([]);
  clipsRef.current = clips;

  useEffect(() => {
    return () => {
      clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    };
  }, []);

  const updateClip = (id: string, patch: Partial<Clip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addFiles = (files: File[]) => {
    const newClips: Clip[] = files.map((file) => ({
      id: `clip-${clipIdCounter++}`,
      file,
      url: URL.createObjectURL(file),
      width: 0,
      height: 0,
      duration: 0,
      hasAudio: false,
      loading: true,
      trimStart: 0,
      trimEnd: 0,
      expanded: false,
    }));
    setClips((prev) => [...prev, ...newClips]);

    for (const clip of newClips) {
      const ext = guessVideoExtension(clip.file);
      Promise.all([
        readVideoMetadata(clip.file),
        probeHasAudio(clip.file, `probe-${clip.id}.${ext}`).catch(() => false),
      ])
        .then(([{ width, height, duration }, hasAudio]) => {
          setClips((prev) =>
            prev.map((c) =>
              c.id === clip.id
                ? { ...c, width, height, duration, hasAudio, trimStart: 0, trimEnd: duration, loading: false }
                : c,
            ),
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

  const removeClip = (id: string) => {
    setClips((prev) => {
      const clip = prev.find((c) => c.id === id);
      if (clip) URL.revokeObjectURL(clip.url);
      return prev.filter((c) => c.id !== id);
    });
  };

  const handleExport = async () => {
    if (clips.length < 2) return;
    const target = clips[0];
    const w = evenRound(target.width || 1280);
    const h = evenRound(target.height || 720);

    const ranges = clips.map((clip) => {
      const start = Math.max(0, Math.min(clip.trimStart, clip.duration || clip.trimStart));
      const rawEnd = clip.trimEnd > start ? clip.trimEnd : clip.duration || start;
      const end = Math.max(start + 0.05, rawEnd);
      return { start, duration: end - start };
    });

    // Every clip's video input gets its own index. Clips with no audio get an
    // extra silent-audio input appended after it, backed by a real generated
    // WAV file rather than an `-f lavfi -i anullsrc` source — the wasm build
    // of ffmpeg used here hangs indefinitely once concat pulls from a lavfi
    // source, so a real file sidesteps that entirely.
    const inputs: { name: string; data: File | Blob }[] = [];
    const inputArgs: string[] = [];
    const videoInputIndex: number[] = [];
    const audioInputIndex: number[] = [];
    let nextInputIndex = 0;
    clips.forEach((clip, i) => {
      const name = `clip${i}.${guessVideoExtension(clip.file)}`;
      inputs.push({ name, data: clip.file });
      inputArgs.push("-ss", toFfmpegTimestamp(ranges[i].start), "-t", toFfmpegTimestamp(ranges[i].duration), "-i", name);
      videoInputIndex[i] = nextInputIndex++;
      if (clip.hasAudio) {
        audioInputIndex[i] = videoInputIndex[i];
      } else {
        const silenceName = `silence${i}.wav`;
        inputs.push({ name: silenceName, data: createSilentWav(ranges[i].duration) });
        inputArgs.push("-i", silenceName);
        audioInputIndex[i] = nextInputIndex++;
      }
    });

    const chains: string[] = [];
    const labels: string[] = [];
    clips.forEach((_clip, i) => {
      chains.push(
        `[${videoInputIndex[i]}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`,
      );
      chains.push(`[${audioInputIndex[i]}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    const filterComplex = `${chains.join(";")};${labels.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`;

    const args: string[] = [
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "output.mp4",
    ];

    await exportState.run(
      { inputs, args, outputName: "output.mp4", outputMimeType: "video/mp4" },
      "merged.mp4",
    );
  };

  const reset = () => {
    exportState.reset();
    clips.forEach((c) => URL.revokeObjectURL(c.url));
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
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      {clips.length === 0 ? (
        <Dropzone
          accept="video/*"
          multiple
          label="Drop two or more videos here, or click to browse"
          hint="They'll be joined in the order you add them — reorder anytime below. Videos with or without audio are both fine."
          onFiles={addFiles}
        />
      ) : (
        <div className="space-y-2">
          {clips.map((clip, i) => {
            const trimmed = clip.trimStart > 0 || (clip.trimEnd > 0 && clip.trimEnd < clip.duration);
            return (
              <div key={clip.id} className="rounded-lg border border-(--color-border) px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-bg-subtle) text-caption font-semibold tabular-nums">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-sm font-medium">{clip.file.name}</p>
                    <p className="text-caption text-(--color-text-muted)">
                      {clip.loading
                        ? "Reading…"
                        : `${formatTime(clip.duration)} · ${clip.width}×${clip.height} · ${
                            clip.hasAudio ? "has audio" : "no audio (silent track will be added)"
                          }${trimmed ? ` · using ${formatTime(clip.trimEnd - clip.trimStart)}` : ""}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={clip.expanded ? "Hide trim controls" : "Trim this clip"}
                    disabled={clip.loading}
                    onClick={() => updateClip(clip.id, { expanded: !clip.expanded })}
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded hover:bg-(--color-bg-subtle) disabled:opacity-30 ${
                      clip.expanded ? "bg-(--color-bg-subtle) text-primary-600" : ""
                    }`}
                  >
                    <Scissors size={14} />
                  </button>
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

                {clip.expanded && !clip.loading && (
                  <div className="mt-3 space-y-1 border-t border-(--color-border) pt-3">
                    <video
                      ref={(el) => {
                        videoRefs.current[clip.id] = el;
                      }}
                      src={clip.url}
                      controls
                      muted={!clip.hasAudio}
                      className="max-h-56 w-full rounded-lg bg-black"
                      onTimeUpdate={(e) =>
                        setCurrentTimes((prev) => ({ ...prev, [clip.id]: e.currentTarget.currentTime }))
                      }
                    />
                    <TrimSlider
                      duration={clip.duration}
                      start={clip.trimStart}
                      end={clip.trimEnd || clip.duration}
                      currentTime={currentTimes[clip.id] ?? 0}
                      onChangeStart={(t) => updateClip(clip.id, { trimStart: t })}
                      onChangeEnd={(t) => updateClip(clip.id, { trimEnd: t })}
                      onSeek={(t) => {
                        const el = videoRefs.current[clip.id];
                        if (el) el.currentTime = t;
                      }}
                    />
                    <div className="flex justify-between text-caption tabular-nums text-(--color-text-muted)">
                      <span>{formatTime(clip.trimStart, true)}</span>
                      <span>
                        Using {formatTime((clip.trimEnd || clip.duration) - clip.trimStart)} of{" "}
                        {formatTime(clip.duration)}
                      </span>
                      <span>{formatTime(clip.trimEnd || clip.duration, true)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

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
