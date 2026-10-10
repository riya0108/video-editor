import { createProbeDeps, renderProbe } from "../render/probe-harness";
import { exportProbe, toneWavUrl } from "../export/export-harness";
import type { RenderSettings } from "../render/settings";
import type { RenderDeps } from "../render/job";

/**
 * RELEASE-CANDIDATE RE-RENDER (RELEASE_CANDIDATE_REPORT.md §3): regenerates the Phase 15 render and Phase 16 export
 * evaluation files with the CURRENT code, so the ffmpeg-based eval suites (real-render / export-real) check what this
 * build produces — not files rendered before Phase 18 changed decoding and compositing. Inputs are read back from the
 * original runs' metadata, so every case is the same case.
 */

const ROOT = "/@fs/Users/teri/Downloads/Video Editor/.tmp-test-assets/";
const assets = { counterUrl: ROOT + "phase15/counter30.mp4", logoUrl: ROOT + "phase15/logo-half-red.png" };
let deps: Promise<RenderDeps> | null = null;

export async function regenRender(name: string) {
  const meta = await (await fetch(`${ROOT}phase15/${name}.meta.json`)).json();
  const s = meta.plan.settings as RenderSettings;
  deps ??= createProbeDeps({ ...assets, toneUrl: toneWavUrl() });
  const r = await renderProbe(await deps, meta.layout.width, meta.layout.height, s);
  return r;
}

/** The two refusal cases recorded only their refusal, not their input: these are the inputs the eval suite describes. */
const REFUSED: Record<string, { comp: [number, number]; overrides: Record<string, unknown> }> = {
  "e-refused-hevc-webm": { comp: [1920, 1080], overrides: { container: "webm", videoCodec: "hevc", audioCodec: "opus" } },
  "e-refused-opus-mp4": { comp: [1920, 1080], overrides: { container: "mp4", videoCodec: "avc", audioCodec: "opus" } },
};

export async function regenExport(name: string) {
  if (REFUSED[name]) return exportProbe({ assets, comp: REFUSED[name].comp, preset: "custom", overrides: REFUSED[name].overrides as never });
  const meta = await (await fetch(`${ROOT}phase16/final/${name}.meta.json`)).json();
  const transparent = meta.timeline?.composition?.background === "transparent";
  const cancelAt = meta.status === "cancelled" ? Math.max(1, ...(meta.progressSeen as { phase: string; fraction: number }[]).filter((p) => p.phase === "video").map((p) => Math.round(p.fraction * (meta.plan?.frameCount ?? 120)))) : undefined;
  // e-cancel-mid was recorded (Phase 16) with AAC 384 kbit/s, which the later preflight now refuses before rendering a
  // frame — so it could never reach the cancel point. It tests cancellation, so it runs at a bitrate that encodes.
  const overrides = name === "e-cancel-mid" ? { ...meta.profile, audioBitrate: 192_000 } : meta.profile;
  return exportProbe({ assets, comp: [meta.layout.width, meta.layout.height], preset: meta.profile.presetId, overrides, variant: transparent ? "alpha" : "standard", cancelAtFrame: cancelAt });
}
