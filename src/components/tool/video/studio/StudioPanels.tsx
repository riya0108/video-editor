import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, FileAudio, Download, Loader2, Lock, Volume2, VolumeX } from "lucide-react";
import type { TimelineEngine, EditResult } from "../../../../lib/timeline/engine";
import { timelineDurationFrames, type CompositionSettings, type TimelineModel } from "../../../../lib/timeline/model";
import { clipTimelineEnd, isTrimmableContent, type Clip } from "../../../../lib/timeline/clip";
import { defaultClipVisual, type ClipVisual, type ClipVisualPatch } from "../../../../lib/timeline/visual";
import { normalizeTextStyle } from "../../../../lib/timeline/text-style";
import { normalizeShapeSpec, normalizeSvgSpec } from "../../../../lib/timeline/shape-style";
import type { AuthoredContentPatch } from "../../../../lib/timeline/operations";
import { FinalRenderError, type BoxSize, type FinalRenderer, type SafeZone, type TextLayout } from "../../../../lib/composition";
import { encodeWav16, mixTimeline } from "../../../../lib/audio/engine-core";
import type { AudioSourceStore } from "../../../../lib/audio/source-store";
import TextPanel, { type TextPanelProps } from "../composition/TextPanel";
import GraphicsPanel from "../composition/GraphicsPanel";
import TransformPanel, { type KeyframeControl } from "../composition/TransformPanel";

/**
 * STUDIO PANELS — the layer list, the selection's properties, and the two secondary exports (final-quality frame,
 * audio mix). Moved out of the editor shell unchanged in behavior.
 */

export function LayersPanel({ engine, frame, selectedIds, onSelect, apply }: { engine: TimelineEngine; frame: number; selectedIds: string[]; onSelect: (ids: string[]) => void; apply: (r: EditResult) => void }) {
  const tl = engine.timeline;
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">Layers <span className="font-normal text-(--color-text-muted)">(top = front)</span></h2>
      <ul className="divide-y divide-(--color-border)">
        {tl.trackIds.map((trackId, index) => {
          const track = tl.tracks[trackId];
          const clips = track.clipIds.map((id) => tl.clips[id]);
          const active = clips.find((c) => frame >= c.timelineStart && frame < clipTimelineEnd(c)) ?? clips[0];
          const selected = clips.some((c) => selectedIds.includes(c.id));
          return (
            <li key={trackId} className={`flex items-center gap-1 px-2 py-1.5 text-caption ${selected ? "bg-primary-500/10" : ""}`}>
              {track.kind === "audio" ? (
                // Audio has nothing to show or hide — its toggle is mute.
                <button type="button" onClick={() => apply(engine.setTrackMuted(trackId, !track.muted))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label={track.muted ? "Unmute track" : "Mute track"}>
                  {track.muted ? <VolumeX className="h-3.5 w-3.5 text-(--color-text-faint)" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
              ) : (
                <button type="button" onClick={() => apply(engine.setTrackVisible(trackId, !track.visible))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label={track.visible ? "Hide layer" : "Show layer"}>
                  {track.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-(--color-text-faint)" />}
                </button>
              )}
              <button type="button" onClick={() => apply(engine.setTrackLocked(trackId, !track.locked))} className={`rounded p-1 hover:bg-(--color-bg-subtle) ${track.locked ? "" : "text-(--color-text-faint)"}`} aria-label={track.locked ? "Unlock layer" : "Lock layer"}>
                <Lock className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  if (!active) return;
                  // Shift-click toggles, like on the canvas.
                  if (e.shiftKey) onSelect(selectedIds.includes(active.id) ? selectedIds.filter((id) => id !== active.id) : [...selectedIds, active.id]);
                  else onSelect([active.id]);
                }}
                className="min-w-0 flex-1 truncate text-left hover:underline" title={track.name}>
                {track.name} <span className="text-(--color-text-faint)">· {track.kind}</span>
              </button>
              <button type="button" disabled={index === 0} onClick={() => apply(engine.reorderTrack(trackId, index - 1))} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Bring forward">
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" disabled={index === tl.trackIds.length - 1} onClick={() => apply(engine.reorderTrack(trackId, index + 1))} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Send backward">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Text content (text clips only) + the reusable TransformPanel. */
/** Text (TextPanel, text layers only) + the reusable TransformPanel — one control per model field. */
export function PropertiesPanel({
  clip,
  layerBox,
  textLayout,
  composition,
  safeZones: zones,
  locked,
  draft,
  onDraft,
  onCommit,
  text,
  graphic,
  visualAtPlayhead,
  keyframes,
}: {
  clip: Clip;
  layerBox: BoxSize | null;
  textLayout: TextLayout | null;
  composition: CompositionSettings;
  safeZones: readonly SafeZone[];
  locked: boolean;
  draft: ClipVisual | null;
  onDraft: (v: ClipVisual | null) => void;
  onCommit: (patch: ClipVisualPatch) => void;
  text?: Omit<TextPanelProps, "text" | "style" | "layout" | "opacity" | "locked" | "onCommitOpacity">;
  graphic?: { onDraft: (patch: AuthoredContentPatch | null) => void; onCommit: (patch: AuthoredContentPatch) => void };
  /** The visual as evaluated at the playhead (animation applied) — what the fields must show. */
  visualAtPlayhead: ClipVisual | null;
  keyframes?: (path: string) => KeyframeControl;
}) {
  // Show what's on screen at the playhead (animated values), not the stored base.
  const stored = visualAtPlayhead ?? clip.visual ?? defaultClipVisual(composition.width, composition.height);
  const c = clip.content;
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="flex items-center justify-between border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        {c.kind === "text" ? "Text" : c.kind === "graphic" && (c.shape || c.svg) ? "Graphic" : "Transform"} <span className="font-normal text-(--color-text-muted)">{c.kind}{locked ? " · locked" : ""}{draft ? " · editing" : ""}</span>
      </h2>
      <div className="flex flex-col gap-3 p-3">
        {c.kind === "text" && text && (
          <>
            <TextPanel {...text} text={c.text ?? ""} style={normalizeTextStyle(c.textStyle)} layout={textLayout} opacity={stored.opacity} locked={locked} onCommitOpacity={(opacity) => onCommit({ opacity })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        {c.kind === "graphic" && graphic && c.shape && (
          <>
            <GraphicsPanel kind="shape" spec={normalizeShapeSpec(c.shape)} locked={locked} onDraft={(p) => graphic.onDraft(p ? { shape: p } : null)} onCommit={(p) => graphic.onCommit({ shape: p })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        {c.kind === "graphic" && graphic && c.svg && (
          <>
            <GraphicsPanel kind="svg" spec={normalizeSvgSpec(c.svg) ?? c.svg} locked={locked} onDraft={(p) => graphic.onDraft(p ? { svg: p } : null)} onCommit={(p) => graphic.onCommit({ svg: p })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        <TransformPanel
          visual={stored}
          box={layerBox}
          fitLocked={c.kind === "text" || (c.kind === "graphic" && (!!c.shape || !!c.svg))}
          composition={composition}
          safeZones={zones}
          locked={locked}
          onDraft={onDraft}
          onCommit={onCommit}
          keyframes={keyframes}
        />
      </div>
    </section>
  );
}

export function FinalRenderBox({ renderer, timeline, frame }: { renderer: FinalRenderer; timeline: TimelineModel; frame: number }) {
  const [state, setState] = useState<{ status: "idle" | "rendering" | "done" | "error"; url?: string; ms?: number; size?: string; message?: string }>({ status: "idle" });
  useEffect(() => () => void (state.url && URL.revokeObjectURL(state.url)), [state.url]);

  const render = async () => {
    setState({ status: "rendering" });
    const t0 = performance.now();
    try {
      const { canvas } = await renderer.renderFrame(timeline, frame);
      const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
      setState({ status: "done", url: URL.createObjectURL(blob), ms: performance.now() - t0, size: `${canvas.width}×${canvas.height}` });
    } catch (e) {
      setState({ status: "error", message: e instanceof FinalRenderError ? e.message : `Unexpected: ${(e as Error).message}` });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption">
      <button type="button" onClick={render} disabled={state.status === "rendering"} className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
        {state.status === "rendering" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        Render this frame (final quality)
      </button>
      <span className="text-(--color-text-muted)">Separate renderer: full composition resolution, exact source frame, high-quality resampling — independent of the preview setting.</span>
      {state.status === "done" && state.url && (
        <span className="flex items-center gap-2" data-testid="final-render-result">
          <img src={state.url} alt="Final render" className="h-10 rounded border border-(--color-border) bg-checkerboard" />
          <span className="tabular-nums">{state.size} · {state.ms!.toFixed(0)} ms</span>
          <a href={state.url} download={`frame-${frame}.png`} className="underline">Download PNG</a>
        </span>
      )}
      {state.status === "error" && <span className="text-danger-600">{state.message}</span>}
    </div>
  );
}

/**
 * AUDIO EXPORT (AUDIO_ENGINE_ARCHITECTURE.md §8): renders the whole timeline's mix with the offline mixer — the same
 * segments and gain envelopes playback schedules — to a 16-bit stereo WAV. Refuses (with the list) when an audio clip's
 * source is missing or failed to decode, rather than exporting a mix with silent holes; warns when the mix clips.
 */
export function AudioExportBox({ store, timeline }: { store: AudioSourceStore; timeline: TimelineModel }) {
  const [state, setState] = useState<{ status: "idle" | "rendering" | "done" | "error"; url?: string; message?: string; info?: string }>({ status: "idle" });
  useEffect(() => () => void (state.url && URL.revokeObjectURL(state.url)), [state.url]);
  const run = async () => {
    setState({ status: "rendering" });
    await new Promise((r) => setTimeout(r, 0));
    const problems = Object.values(timeline.clips)
      .filter((c) => c.content.kind === "audio" && isTrimmableContent(c.content))
      .map((c) => ({ c, st: store.status((c.content as { source: { sourceId: string } }).source.sourceId) }))
      .filter((x) => x.st.state !== "ready");
    if (problems.length > 0) {
      const names = problems.map((p) => `${(p.c.content as { source: { label?: string; sourceId: string } }).source.label ?? p.c.id} (${p.st.state})`);
      return setState({ status: "error", message: `Can't export: ${problems.length} audio clip(s) have no playable audio — ${names.join(", ")}. Re-add or remove them first.` });
    }
    const t0 = performance.now();
    const durationSec = Math.max(1, timelineDurationFrames(timeline)) / timeline.frameRate;
    const mix = mixTimeline(timeline, (id) => store.pcm(id), { sampleRate: store.sampleRate, startSec: 0, endSec: durationSec });
    const wav = encodeWav16(mix.channels, mix.sampleRate);
    const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
    const peakDb = mix.peak > 0 ? 20 * Math.log10(mix.peak) : -Infinity;
    setState({
      status: "done",
      url,
      info: `${durationSec.toFixed(2)} s · ${(mix.sampleRate / 1000).toFixed(1)} kHz stereo · peak ${Number.isFinite(peakDb) ? peakDb.toFixed(1) : "−∞"} dBFS · ${(performance.now() - t0).toFixed(0)} ms${mix.clippedSamples ? ` · ⚠ ${mix.clippedSamples} samples clipped — lower some volumes` : ""}`,
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption">
      <button type="button" onClick={run} disabled={state.status === "rendering"} className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
        {state.status === "rendering" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileAudio className="h-3.5 w-3.5" />}
        Export audio mix (WAV)
      </button>
      <span className="text-(--color-text-muted)">Every audible track mixed with volume, gain, fades, automation, mute/solo — the same mix playback plays.</span>
      {state.status === "done" && state.url && (
        <span className="flex items-center gap-2" data-testid="audio-export-result">
          <audio src={state.url} controls className="h-8" />
          <span className="tabular-nums">{state.info}</span>
          <a href={state.url} download="mix.wav" className="underline">Download WAV</a>
        </span>
      )}
      {state.status === "error" && <span className="text-danger-600" role="alert">{state.message}</span>}
    </div>
  );
}
