import { deleteClips } from "../timeline/operations";
import type { TimelineModel } from "../timeline/model";
import { buildProbeProject, type ProbeLayout } from "../render/probe-project";
import { createProbeDeps, type ProbeAssets } from "../render/probe-harness";
import { renderTimeline, type RenderDeps } from "../render/job";
import { checkExportProfile, type ExportProfile } from "./profile";
import { presetById, presetProfile, type PresetId } from "./presets";
import { exportFileName, ExportQueue, type ExportJob } from "./queue";

/**
 * BROWSER TEST HARNESS for the real export tests (EXPORT_TEST_REPORT.md) — not used by the app. Builds the Phase 15
 * probe project, turns a preset (+ overrides) into a checked profile, and runs it through the production
 * ExportQueue → renderTimeline, returning the written file (base64), the job's status history, the in-app report,
 * and everything the Node side needs to check the file independently with ffmpeg.
 *
 * Variant "alpha": the counter video is removed and the background made transparent, so the frame has real
 * transparency (empty areas, the 50 %-alpha logo) for the alpha checks.
 */

export type ProbeVariant = "standard" | "alpha";

let depsPromise: Promise<RenderDeps> | null = null;

/** A 44.1 kHz mono WAV: a quiet 440 Hz bed with 1 kHz beeps at 1.0 s and 2.5 s (heard at 1.5 / 3.0 s on the timeline). */
export function toneWavUrl(): string {
  const sr = 44100;
  const n = Math.round(sr * 3.5);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const beep = (t >= 1 && t < 1.1) || (t >= 2.5 && t < 2.6);
    const x = beep ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0.05 * Math.sin(2 * Math.PI * 440 * t);
    v.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export function probeTimeline(width: number, height: number, variant: ProbeVariant): { timeline: TimelineModel; layout: ProbeLayout } {
  const { timeline, layout, ids } = buildProbeProject(width, height);
  if (variant === "standard") return { timeline, layout };
  const tl = deleteClips(timeline, [ids.videoA, ids.videoB]);
  return { timeline: { ...tl, composition: { ...tl.composition, background: "transparent" } }, layout };
}

let queue: ExportQueue | null = null;

export async function exportProbe(input: { assets: Omit<ProbeAssets, "toneUrl">; comp: [number, number]; preset: PresetId; overrides?: Partial<ExportProfile>; variant?: ProbeVariant; cancelAtFrame?: number }) {
  depsPromise ??= createProbeDeps({ ...input.assets, toneUrl: toneWavUrl() });
  const deps = await depsPromise;
  const { timeline, layout } = probeTimeline(input.comp[0], input.comp[1], input.variant ?? "standard");
  const profile: ExportProfile = { ...presetProfile(input.preset, timeline), ...input.overrides };
  const check = checkExportProfile(timeline, profile, presetById(input.preset)?.guidance);
  if (!check.ok) return { refused: check.errors };
  // A fresh queue per call keeps runs independent; the runner is the production render job.
  let cancelId: string | null = null;
  queue = new ExportQueue(async (tl, s, opts) => {
    const outcome = await renderTimeline(tl, s, deps, {
      ...opts,
      onProgress: (p) => {
        opts.onProgress(p);
        if (input.cancelAtFrame !== undefined && p.phase === "video" && p.done >= input.cancelAtFrame && cancelId) queue!.cancel(cancelId);
      },
    });
    return outcome;
  });
  const progressSeen: { phase: string; fraction: number }[] = [];
  queue.subscribe((jobs) => {
    const p = jobs[0]?.progress;
    if (p && progressSeen.at(-1)?.phase !== p.phase) progressSeen.push({ phase: p.phase, fraction: p.fraction });
  });
  const t0 = performance.now();
  const id = queue.enqueue({ name: input.preset, presetId: input.preset, settings: check.settings, fileName: exportFileName(input.preset, check.settings), timeline });
  cancelId = id;
  await queue.idle();
  const job = queue.get(id)! as ExportJob;
  let base64: string | null = null;
  if (job.outcome) {
    const bytes = new Uint8Array(await job.outcome.blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    base64 = btoa(bin);
  }
  return {
    status: job.status,
    history: job.history,
    error: job.error ?? null,
    fileName: job.fileName,
    fileBase64: base64,
    report: job.outcome?.report ?? null,
    plan: job.outcome?.plan ?? null,
    profile,
    profileWarnings: check.warnings,
    layout,
    timeline,
    progressSeen,
    wallMs: performance.now() - t0,
  };
}
