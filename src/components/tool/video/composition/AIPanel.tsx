import { useEffect, useMemo, useReducer, useState } from "react";
import { Ban, Check, Loader2, Play, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import type { Clip } from "../../../../lib/timeline/clip";
import type { TimelineModel } from "../../../../lib/timeline/model";
import type { AIEditingSession } from "../../../../lib/ai/session";
import type { AIJob } from "../../../../lib/ai/jobs";
import { AIError } from "../../../../lib/ai/errors";
import type { AnyProvider } from "../../../../lib/ai/registry";
import type { Availability } from "../../../../lib/ai/provider";
import { confidenceBand, type AIFeatureId, type AIResult, type AIResultItem, type Box, type ProviderKind } from "../../../../lib/ai/types";
import * as apply from "../../../../lib/ai/apply";

/**
 * AI PANEL (AI_EDITING_ARCHITECTURE.md §8). Everything AI in one place, for the selected clip:
 *  - capabilities: what each feature runs on (model / classical / signal processing / heuristic) and, when
 *    unavailable, why — nothing is offered that isn't connected;
 *  - jobs: queued / processing (progress + stage) / completed / failed (typed error) / cancelled, with cancel & retry;
 *  - results: editable items (accept, retime, rename, delete) with their confidence and its basis;
 *  - apply: explicit actions that turn accepted items into editor objects — one undo step each, media untouched.
 */

export interface AIPanelProps {
  session: AIEditingSession;
  timeline: TimelineModel;
  clip: Clip | null;
  frame: number;
  /** Runs a pure timeline edit as one undo step; returns an error message or null. */
  onApply: (edit: (tl: TimelineModel) => TimelineModel) => string | null;
  onSeek: (frame: number) => void;
  /** Source pixel size of a clip's media (for reframe / removal placement). */
  sourceSize: (clip: Clip) => { width: number; height: number } | null;
  /** Maps a normalized point of the analysed clip's picture to composition px at a frame (for "attach layer"). */
  pictureToComp: (clipId: string, frame: number) => ((nx: number, ny: number) => { x: number; y: number }) | null;
  /** Other layers that can be attached to a track. */
  layers: { id: string; label: string }[];
}

const FEATURE_LABEL: Record<AIFeatureId, string> = {
  "shot-detection": "Shots",
  "scene-detection": "Scenes",
  "object-detection": "Objects",
  "face-detection": "Faces",
  "speaker-detection": "Speakers",
  "silence-detection": "Silences",
  "filler-detection": "Filler words",
  "auto-reframe": "Auto reframe",
  "highlight-detection": "Highlights",
  "object-removal": "Object removal",
  "object-tracking": "Object tracking",
  "broll-suggestions": "B-roll ideas",
};

const KIND_BADGE: Record<ProviderKind, { label: string; cls: string; title: string }> = {
  "ml-model": { label: "Model", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300", title: "A trained neural network runs on your device" },
  "classical-cv": { label: "Classical CV", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300", title: "A deterministic computer-vision algorithm (no model)" },
  "signal-processing": { label: "Signal", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", title: "A deterministic audio-signal algorithm (no model)" },
  heuristic: { label: "Heuristic", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300", title: "A hand-tuned score over other signals — a suggestion, not a judgement" },
};

const STATUS_CLS: Record<AIJob["status"], string> = {
  queued: "bg-zinc-500/15",
  processing: "bg-primary-500/15 text-primary-700 dark:text-primary-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled: "bg-zinc-500/15 text-(--color-text-muted)",
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function itemSummary(it: AIResultItem): string {
  switch (it.kind) {
    case "shot":
      return `${it.transitionIn === "start" ? "First shot" : it.transitionIn === "dissolve" ? "Dissolve →" : "Cut →"} ${fmt(it.start)}–${fmt(it.end)}`;
    case "scene":
      return `Scene ${fmt(it.start)}–${fmt(it.end)} · ${it.shotIds.length} shot${it.shotIds.length === 1 ? "" : "s"}`;
    case "detection-track":
      return `${it.label} · ${fmt(it.start)}–${fmt(it.end)} · ${it.detections.length} sightings`;
    case "speaker-turn":
      return `${it.speaker} · ${fmt(it.start)}–${fmt(it.end)}`;
    case "silence":
      return `Silence ${fmt(it.start)}–${fmt(it.end)} (${(it.end - it.start).toFixed(2)} s, ${it.levelDb} dB)`;
    case "filler":
      return `“${it.text}” ${fmt(it.start)} (${it.category})`;
    case "reframe":
      return `${it.aspect.toFixed(3)} crop following ${it.subject} · ${it.keys.length} samples`;
    case "highlight":
      return `${fmt(it.start)}–${fmt(it.end)} · ${it.reasons.join("; ")}`;
    case "object-removal":
      return `${it.method} · ${pct(it.realBackgroundFraction)} real background · camera motion ${it.cameraMotion}`;
    case "track":
      return `${it.label} · ${it.keys.length} positions${it.lostTimes.length ? ` · lost ${it.lostTimes.length}` : ""}`;
    case "broll":
      return `${fmt(it.start)}–${fmt(it.end)} · “${it.query}”`;
  }
}

const itemStart = (it: AIResultItem): number | null => ("start" in it ? it.start : it.kind === "track" ? it.keys[0]?.time ?? null : it.kind === "reframe" ? it.keys[0]?.time ?? null : null);

export default function AIPanel(p: AIPanelProps) {
  const { session, clip } = p;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [caps, setCaps] = useState<{ feature: AIFeatureId; provider: AnyProvider | null; availability: Availability }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aspect, setAspect] = useState(9 / 16);
  const [speakers, setSpeakers] = useState<number | "auto">("auto");
  const [precision, setPrecision] = useState<"fast" | "precise">("fast");
  const [region, setRegion] = useState<Box>({ x: 0.4, y: 0.3, w: 0.2, h: 0.3 });
  const [attachTo, setAttachTo] = useState<string>("");

  useEffect(() => session.queue.subscribe(() => rerender()), [session]);
  useEffect(() => session.store.subscribe(() => rerender()), [session]);
  useEffect(() => {
    void session.registry.capabilities(session.services).then(setCaps);
  }, [session]);

  const results = clip ? session.store.list({ clipId: clip.id }) : [];
  const jobs = session.queue.jobs.slice(-8).reverse();
  const detections = useMemo(() => results.filter((r) => r.feature === "object-detection" || r.feature === "face-detection").flatMap((r) => r.items.filter((i) => i.kind === "detection-track").map((i) => ({ r, i }))), [results]);

  const run = async (feature: AIFeatureId, params: Record<string, unknown> = {}) => {
    if (!clip) return;
    setError(null);
    setNotice(null);
    try {
      await session.run(feature, clip, params);
    } catch (e) {
      setError(e instanceof AIError ? e.message : String(e));
    }
  };
  const paramsFor = (f: AIFeatureId): Record<string, unknown> => (f === "shot-detection" || f === "scene-detection" ? { precision } : f === "auto-reframe" ? { aspect } : f === "speaker-detection" ? (speakers === "auto" ? {} : { speakers }) : f === "object-tracking" || f === "object-removal" ? { region } : {});

  const doApply = (edit: (tl: TimelineModel) => TimelineModel, ok: string) => {
    setError(null);
    try {
      const err = p.onApply(edit);
      if (err) setError(err);
      else setNotice(ok);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toFrame = (r: AIResult, t: number) => {
    const c = p.timeline.clips[r.target.clipId];
    return c ? apply.sourceToTimeline(p.timeline, c, t) : null;
  };

  const resultActions = (r: AIResult) => {
    const btn = "rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)";
    const size = clip ? p.sourceSize(clip) : null;
    switch (r.feature) {
      case "shot-detection":
      case "scene-detection":
      case "highlight-detection":
        return (
          <button type="button" className={btn} onClick={() => doApply((tl) => apply.splitAtBoundaries(tl, r).timeline, "Split at the accepted boundaries.")}>
            Split clip at {r.feature === "highlight-detection" ? "highlights" : r.feature === "scene-detection" ? "scenes" : "shots"}
          </button>
        );
      case "silence-detection":
      case "filler-detection":
        return (
          <>
            <button type="button" className={btn} onClick={() => doApply((tl) => apply.removeRanges(tl, r, { closeGaps: false }).timeline, "Cut the accepted ranges (gaps left).")}>
              Cut (leave gaps)
            </button>
            <button type="button" className={btn} onClick={() => doApply((tl) => apply.removeRanges(tl, r, { closeGaps: true }).timeline, "Cut the accepted ranges and closed the gaps on this track.")} title="Later clips on this track move left; other tracks are not shifted">
              Cut &amp; close gaps
            </button>
          </>
        );
      case "speaker-detection":
        return (
          <button type="button" className={btn} onClick={() => doApply((tl) => apply.labelCaptionSpeakers(tl, r).timeline, "Labelled captions with speakers.")}>
            Label captions with speakers
          </button>
        );
      case "auto-reframe":
        return (
          <button type="button" className={btn} disabled={!size} onClick={() => size && doApply((tl) => apply.applyReframe(tl, r, size).timeline, "Reframe applied (position keyframes on the clip).")}>
            Apply reframe to clip
          </button>
        );
      case "broll-suggestions":
        return (
          <button type="button" className={btn} onClick={() => doApply((tl) => apply.addBrollPlaceholders(tl, r).timeline, "Added B-roll placeholder layers.")}>
            Add placeholders
          </button>
        );
      default:
        return null;
    }
  };

  const itemActions = (r: AIResult, it: AIResultItem) => {
    const b = "rounded px-1.5 py-0.5 border border-(--color-border) hover:bg-(--color-bg-subtle)";
    if (it.kind === "detection-track" || it.kind === "track") {
      const first = it.kind === "track" ? it.keys[0] : it.detections[0];
      const box = first?.box;
      return (
        <span className="flex flex-wrap gap-1">
          <button type="button" className={b} onClick={() => doApply((tl) => apply.maskFromTrack(tl, r, it.id, { mode: "mask" }).timeline, "Added a mask that follows it.")}>
            Mask
          </button>
          <button type="button" className={b} onClick={() => doApply((tl) => apply.maskFromTrack(tl, r, it.id, { mode: "blur" }).timeline, "Added a blurred, masked copy above the clip.")}>
            Blur
          </button>
          {it.kind === "detection-track" && box && (
            <>
              <button type="button" className={b} onClick={() => void run("object-tracking", { region: box, startTime: first.time, label: it.label })}>
                Track
              </button>
              <button type="button" className={b} onClick={() => void run("object-removal", { region: { x: Math.max(0, box.x - box.w * 0.15), y: Math.max(0, box.y - box.h * 0.15), w: Math.min(1, box.w * 1.3), h: Math.min(1, box.h * 1.3) } })}>
                Remove
              </button>
            </>
          )}
          {it.kind === "track" && attachTo && (
            <button type="button" className={b} onClick={() => doApply((tl) => apply.attachLayerToTrack(tl, r, it.id, attachTo, (cid, f) => { const m = p.pictureToComp(cid, f); return m ? { boxCenterToComp: m } : null; }).timeline, "The layer now follows the track.")}>
              Attach layer
            </button>
          )}
        </span>
      );
    }
    if (it.kind === "object-removal") {
      const size = clip ? p.sourceSize(clip) : null;
      return (
        <button type="button" className={b} disabled={!size} onClick={() => size && doApply((tl) => apply.addObjectRemovalLayer(tl, r, it.id, { width: Number(r.metrics.plateWidth), height: Number(r.metrics.plateHeight) }, size).timeline, "Added the clean-plate patch layer above the clip.")}>
          Add patch layer
        </button>
      );
    }
    return null;
  };

  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface) text-caption" data-testid="ai-panel">
      <h2 className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        <Sparkles className="h-4 w-4" /> AI tools
        <span className="ml-auto truncate text-caption font-normal text-(--color-text-muted)">{clip ? `on: ${(clip.content as { source?: { label?: string } }).source?.label ?? clip.id}` : "select a video/image/audio layer"}</span>
      </h2>

      <ul className="divide-y divide-(--color-border)" data-testid="ai-capabilities">
        {caps.map((c) => {
          const kind = c.provider ? KIND_BADGE[c.provider.kind] : null;
          return (
            <li key={c.feature} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-feature={c.feature} data-available={c.availability.available}>
              <span className="w-28 font-medium">{FEATURE_LABEL[c.feature]}</span>
              {kind && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${kind.cls}`} title={`${kind.title}${c.provider?.model ? ` — ${c.provider.model.name} (${c.provider.model.license})` : ""}`}>
                  {kind.label}
                </span>
              )}
              {(c.feature === "shot-detection" || c.feature === "scene-detection") && (
                <select value={precision} onChange={(e) => setPrecision(e.target.value as "fast" | "precise")} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label={`${c.feature === "scene-detection" ? "Scene" : "Shot"} detection precision`} title="Precise analyses every frame (slower) and also finds jump cuts">
                  <option value="fast">Fast</option>
                  <option value="precise">Precise</option>
                </select>
              )}
              {c.feature === "auto-reframe" && (
                <select value={aspect} onChange={(e) => setAspect(Number(e.target.value))} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label="Reframe aspect">
                  <option value={9 / 16}>9:16</option>
                  <option value={1}>1:1</option>
                  <option value={4 / 5}>4:5</option>
                  <option value={16 / 9}>16:9</option>
                </select>
              )}
              {c.feature === "speaker-detection" && (
                <select value={String(speakers)} onChange={(e) => setSpeakers(e.target.value === "auto" ? "auto" : Number(e.target.value))} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label="Number of speakers">
                  <option value="auto">auto</option>
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} speakers
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="ml-auto flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 hover:bg-(--color-bg-subtle) disabled:opacity-40"
                disabled={!clip || !c.availability.available}
                title={c.availability.available ? c.provider?.description : c.availability.reason}
                onClick={() => void run(c.feature, paramsFor(c.feature))}
                data-run={c.feature}
              >
                <Play className="h-3 w-3" /> Run
              </button>
              {!c.availability.available && <span className="w-full text-(--color-text-muted)">Unavailable: {c.availability.reason}</span>}
            </li>
          );
        })}
      </ul>

      <details className="border-t border-(--color-border) px-3 py-2">
        <summary className="cursor-pointer font-medium">Region for tracking / removal</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              {k.toUpperCase()}
              <input type="number" min={0} max={100} step={1} value={Math.round(region[k] * 100)} onChange={(e) => setRegion({ ...region, [k]: Math.min(1, Math.max(0, Number(e.target.value) / 100)) })} className="w-14 rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label={`Region ${k}`} />%
            </label>
          ))}
          {detections.length > 0 && (
            <select
              className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5"
              value=""
              aria-label="Use a detected object as the region"
              onChange={(e) => {
                const d = detections[Number(e.target.value)];
                if (d && d.i.kind === "detection-track") setRegion(d.i.detections[0].box);
              }}
            >
              <option value="">Use detected…</option>
              {detections.map((d, k) => (
                <option key={d.i.id} value={k}>
                  {d.i.kind === "detection-track" ? `${d.i.label} @ ${fmt(d.i.start)}` : ""}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1">
            Attach layer to tracks:
            <select value={attachTo} onChange={(e) => setAttachTo(e.target.value)} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5">
              <option value="">—</option>
              {p.layers.filter((l) => l.id !== clip?.id).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      {error && <p className="border-t border-(--color-border) px-3 py-2 text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {notice && <p className="border-t border-(--color-border) px-3 py-2 text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}

      {jobs.length > 0 && (
        <ul className="divide-y divide-(--color-border) border-t border-(--color-border)" data-testid="ai-jobs">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-col gap-1 px-3 py-1.5" data-job-status={j.status} data-job-feature={j.feature}>
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLS[j.status]}`}>{j.status}</span>
                <span className="flex-1 truncate">{j.label}</span>
                {j.status === "processing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {(j.status === "queued" || j.status === "processing") && (
                  <button type="button" onClick={() => session.queue.cancel(j.id)} className="rounded p-0.5 hover:bg-(--color-bg-subtle)" aria-label="Cancel job">
                    <Ban className="h-3.5 w-3.5" />
                  </button>
                )}
                {(j.status === "failed" || j.status === "cancelled") && (
                  <button type="button" onClick={() => session.queue.retry(j.id)} className="rounded p-0.5 hover:bg-(--color-bg-subtle)" aria-label="Retry job">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {j.status === "processing" && (
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded bg-(--color-bg-subtle)">
                    <div className="h-full bg-primary-500" style={{ width: pct(j.progress) }} />
                  </div>
                  <span className="text-(--color-text-muted)">{j.stage ?? ""}</span>
                </div>
              )}
              {j.error && j.status === "failed" && <span className="text-red-600 dark:text-red-400">{j.error.code}: {j.error.message}</span>}
            </li>
          ))}
        </ul>
      )}

      {results.map((r) => (
        <div key={r.id} className="border-t border-(--color-border) px-3 py-2" data-result-feature={r.feature} data-result-id={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{FEATURE_LABEL[r.feature]}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_BADGE[r.providerKind].cls}`}>{KIND_BADGE[r.providerKind].label}</span>
            <span className="text-(--color-text-muted)">
              {r.items.length} item{r.items.length === 1 ? "" : "s"} · {(r.metrics.durationMs / 1000).toFixed(1)} s{r.model ? ` · ${r.model.name}` : ""}
            </span>
            <button type="button" onClick={() => session.store.remove(r.id)} className="ml-auto rounded p-0.5 hover:bg-(--color-bg-subtle)" aria-label="Discard result">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {r.warnings.map((w) => (
            <p key={w} className="text-amber-700 dark:text-amber-300">
              {w}
            </p>
          ))}
          <ol className="mt-1 flex max-h-56 flex-col gap-0.5 overflow-auto">
            {r.items
              .filter((it) => !(r.feature === "scene-detection" && it.kind === "shot"))
              .slice(0, 60)
              .map((it) => {
                const start = itemStart(it);
                const f = start !== null ? toFrame(r, start) : null;
                return (
                  <li key={it.id} className={`flex flex-wrap items-center gap-1.5 ${it.accepted ? "" : "opacity-50"}`} data-item-kind={it.kind}>
                    <input type="checkbox" checked={it.accepted} onChange={(e) => session.store.updateItem(r.id, it.id, { accepted: e.target.checked })} aria-label="Accept" />
                    <button type="button" className="flex-1 truncate text-left hover:underline" disabled={f === null} onClick={() => f !== null && p.onSeek(f)} title="Go to this moment">
                      {itemSummary(it)}
                    </button>
                    {it.kind === "speaker-turn" && (
                      <input
                        defaultValue={it.speaker}
                        onBlur={(e) => {
                          try {
                            if (e.target.value !== it.speaker) session.store.updateItem(r.id, it.id, { speaker: e.target.value });
                          } catch (err) {
                            setError((err as Error).message);
                          }
                        }}
                        className="w-20 rounded border border-(--color-border) bg-(--color-surface) px-1"
                        aria-label="Speaker name"
                      />
                    )}
                    <span className="text-(--color-text-muted)" title={`Confidence basis: ${it.confidence.basis}`}>
                      {pct(it.confidence.value)} {confidenceBand(it.confidence)}
                    </span>
                    {itemActions(r, it)}
                    <button type="button" onClick={() => session.store.removeItem(r.id, it.id)} className="rounded p-0.5 hover:bg-(--color-bg-subtle)" aria-label="Delete item">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
          </ol>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {r.items.length > 1 && (
              <>
                <button type="button" className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)" onClick={() => session.store.setAllAccepted(r.id, true)}>
                  <Check className="h-3 w-3" /> Accept all
                </button>
                <button type="button" className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)" onClick={() => session.store.setAllAccepted(r.id, false)}>
                  Reject all
                </button>
              </>
            )}
            {resultActions(r)}
          </div>
        </div>
      ))}
    </section>
  );
}
