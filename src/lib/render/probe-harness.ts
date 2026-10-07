import { MediaFrameProvider } from "../composition/media-frame-provider";
import { createCanvasTextMeasurer } from "../composition/text-layout";
import { AudioSourceStore } from "../audio/source-store";
import { buildProbeProject, PROBE_FPS, PROBE_SOURCES } from "./probe-project";
import { renderTimeline, type RenderDeps } from "./job";
import type { RenderSettings } from "./settings";
import { FinalRenderer } from "../composition/final-renderer";
import { buildRenderPlan, frameStep } from "./plan";

/**
 * BROWSER TEST HARNESS for the real rendering tests (RENDER_ENGINE_TEST_REPORT.md) — not used by the app. Loads the
 * probe assets, builds the probe project for an output's shape, renders it through the production `renderTimeline`,
 * and hands back the MP4 (base64) with the in-app validation report and the exact timeline that was rendered, for
 * the Node side to decode with ffmpeg and check independently.
 */

export interface ProbeAssets {
  counterUrl: string;
  logoUrl: string;
  toneUrl: string;
}

export async function createProbeDeps(assets: ProbeAssets): Promise<RenderDeps> {
  const provider = new MediaFrameProvider();
  const measurer = createCanvasTextMeasurer();
  const audio = new AudioSourceStore();
  await provider.addVideo(PROBE_SOURCES.counter, assets.counterUrl, PROBE_FPS);
  await provider.addImage(PROBE_SOURCES.logo, assets.logoUrl);
  // Like the app: every video is offered to the audio store too (the counter has no soundtrack -> "no-audio").
  await audio.add(PROBE_SOURCES.counter, assets.counterUrl, "counter30.mp4", { video: true });
  const toneStatus = await audio.add(PROBE_SOURCES.tone, assets.toneUrl, "tone.wav");
  if (toneStatus.state !== "ready") throw new Error(`tone: ${toneStatus.state}`);
  return {
    provider,
    measurer,
    pcm: (id) => audio.pcm(id),
    audioState: (id) => {
      const st = audio.status(id).state;
      return st === "ready" || st === "loading" || st === "no-audio" || st === "error" ? st : "missing";
    },
  };
}

export async function renderProbe(deps: RenderDeps, compWidth: number, compHeight: number, settings: RenderSettings) {
  const { timeline, layout } = buildProbeProject(compWidth, compHeight);
  const t0 = performance.now();
  const { blob, plan, report } = await renderTimeline(timeline, settings, deps);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mp4Base64: btoa(bin), report, plan, layout, timeline, wallMs: performance.now() - t0 };
}

/** Renders the same frames twice through fresh renderers and compares full-resolution pixels (determinism). */
export async function determinism(deps: RenderDeps, compWidth: number, compHeight: number, settings: RenderSettings, frames: number[]) {
  const { timeline } = buildProbeProject(compWidth, compHeight);
  const plan = buildRenderPlan(timeline, settings);
  const hashes: string[][] = [[], []];
  for (const run of [0, 1]) {
    const r = new FinalRenderer(deps.provider, deps.measurer);
    for (const k of frames) {
      const s = frameStep(plan, k);
      const { canvas } = await r.renderFrame(timeline, s.timelineFrame, { outputScale: plan.renderScale, mediaFrameOffset: plan.mediaFrameOffset });
      const g = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
      hashes[run].push(Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", px))).map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
  }
  return { frames, identical: hashes[0].every((h, i) => h === hashes[1][i]), hashes: hashes[0] };
}
