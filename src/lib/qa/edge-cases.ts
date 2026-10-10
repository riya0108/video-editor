import * as Q from "./qa-harness";
import { renderTimeline } from "../render/job";
import { checkExportProfile } from "../export/profile";
import { presetProfile } from "../export/presets";

/**
 * EDGE-CASE QA (FULL_QA_REPORT.md §3): corrupted / unsupported media, missing media + relink, a long video, a large
 * project, export variants and cancellation. Same live editor, same production paths as projects.ts.
 */

const P11 = ".tmp-test-assets/phase11/";
const P12 = ".tmp-test-assets/phase12/";
const P14 = ".tmp-test-assets/phase14/";
const P15 = ".tmp-test-assets/phase15/";
const P18 = ".tmp-test-assets/phase18/";
const P19 = ".tmp-test-assets/phase19/";

/** E1: every bad file, imported one at a time through the editor's upload path. */
export async function corruptedImports() {
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  Q.newProject(1920, 1080);
  const files = [P19 + "garbage.mp4", P19 + "zero-byte.mp4", P19 + "truncated-video.mp4", P19 + "fake-video.mp4", P11 + "corrupted.mp3", P11 + "truncated.wav", P11 + "legacy.wma", P19 + "heavy-150.srt", P12 + "long.txt"];
  const rows: unknown[] = [];
  for (const f of files) {
    const t0 = performance.now();
    let r: unknown;
    try {
      r = await Q.importMedia([f]);
    } catch (e) {
      r = { threw: `${(e as Error).name}: ${(e as Error).message}` };
    }
    rows.push({ file: f.split("/").pop(), ms: Math.round(performance.now() - t0), result: r });
    // dismiss the error banner so the next file's errors are its own
    (document.querySelector('[aria-label="Dismiss upload errors"]') as HTMLButtonElement | null)?.click();
    await new Promise((res) => setTimeout(res, 100));
  }
  // The truncated video (if accepted): can it be previewed and exported?
  let truncated: unknown = null;
  const tv = Object.values(Q.ed().timeline.clips).find((c) => Q.ed().timeline.tracks[c.trackId].name.includes("truncated-video"));
  if (tv) {
    const d = (tv.content as { sourceOutFrame: number }).sourceOutFrame;
    const preview = await Q.previewCheck([0, Math.floor(d / 2), d - 1]);
    const exp = await Q.exportProject("youtube", {}, { keepBase64: false });
    truncated = { durationFrames: d, preview, exp };
  }
  return { rows, truncated, editorStillWorks: Object.keys(Q.ed().timeline.clips).length, console: Q.takeConsole() };
}

/** E2a: a 3-asset project saved; then one source deleted and one renamed outside the app. */
export async function missingMediaSetup() {
  await Q.ready();
  Q.newProject(1920, 1080);
  await Q.importMedia([P14 + "s1.mp4", P15 + "logo-half-red.png", P11 + "whoosh-sfx.wav"]);
  await Q.audioSettled();
  const fp = await Q.fingerprint([0, 30]);
  const save = await Q.saveAs("e2-missing.clipbench");
  localStorage.setItem("qa:e2", JSON.stringify(fp));
  // Simulate the user deleting / moving files: the stored read handles now point at nothing.
  await Q.removeSeeded("logo-half-red.png");
  await Q.removeSeeded("whoosh-sfx.wav");
  return { save, fp: fp.frames };
}

/** E2b (after reload): reopen with media missing → what the user sees; export attempt; relink → identical project. */
export async function missingMediaReopen() {
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  const reopen = await Q.reopen("e2-missing.clipbench");
  const preview = await Q.previewCheck([0, 30]);
  const exportWhileMissing = await Q.exportProject("youtube", {}, { keepBase64: false });
  const banner = document.body.innerText.match(/[^\n]*(missing|Missing|relink|Relink)[^\n]*/g)?.slice(0, 6) ?? [];
  // Relink: the user finds the files again (the logo under a new name).
  const { manager } = (window as unknown as { __project: { manager: import("../project/manager").ProjectManager } }).__project;
  const [logoH, sfxH] = await Q.seed([P15 + "logo-half-red.png", P11 + "whoosh-sfx.wav"]);
  const relinks: unknown[] = [];
  for (const a of manager.state.assets.filter((x) => x.state !== "ok")) {
    const h = a.label.includes("logo") ? logoH : sfxH;
    const r = await manager.relink(a.id, await h.getFile(), { confirm: true, handle: h });
    relinks.push({ label: a.label, ok: r.ok, match: r.match, errors: r.errors, warnings: r.warnings });
  }
  await Q.audioSettled();
  const saved = JSON.parse(localStorage.getItem("qa:e2") ?? "null") as { frames: { frame: number; sha: string }[] };
  const after = await Q.fingerprint([0, 30]);
  const exportAfterRelink = await Q.exportProject("youtube", {}, { keepBase64: false });
  return { reopen, preview, exportWhileMissing, banner, relinks, framesEqualAfterRelink: saved.frames.map((f, i) => f.sha === after.frames[i].sha), exportAfterRelink, console: Q.takeConsole() };
}

/** E3: a 10-minute 1080p video (158 MB). */
export async function longVideo(phase: "build" | "finish") {
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  if (phase === "build") {
    Q.newProject(1920, 1080);
    const imp = await Q.importMedia([P19 + "long-10min-1080p.mp4"]);
    const audio = await Q.audioSettled(300_000);
    const v = Q.clipOn("long-10min");
    Q.must(Q.ed().setClipVisual(v.id, { fit: "cover", transform: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }));
    Q.must(Q.ed().addTextLayer({ text: "10-minute export", atFrame: 0, durationFrames: 18000, style: { fontSize: 64, color: "#fff" }, visual: { transform: { x: 960, y: 100 } }, name: "Title" }));
    const scrub = await Q.previewCheck([0, 9000, 17999, 4500, 13500, 30]);
    const fp = await Q.fingerprint([0, 9000, 17999]);
    const save = await Q.saveAs("e3-long.clipbench");
    localStorage.setItem("qa:e3", JSON.stringify(fp));
    return { imp, audio, scrub, fp: fp.frames, save, heapMb: Q.memoryMb(), console: Q.takeConsole() };
  }
  const reopen = await Q.reopen("e3-long.clipbench");
  const audio = await Q.audioSettled(300_000);
  const saved = JSON.parse(localStorage.getItem("qa:e3") ?? "null") as { frames: { frame: number; sha: string }[] };
  const after = await Q.fingerprint([0, 9000, 17999]);
  const heapBefore = Q.memoryMb();
  const exp = await Q.exportProject("youtube", {}, { keepBase64: false });
  return { reopen, audio, framesEqual: saved.frames.map((f, i) => f.sha === after.frames[i].sha), exp, heapBefore, heapAfter: Q.memoryMb(), console: Q.takeConsole() };
}

/** E4: a large project — 60 tracks, 600 clips, 3000+ keyframes. Save/reopen/undo/preview/export timings. */
export async function largeProject(phase: "build" | "finish") {
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  if (phase === "build") {
    Q.newProject(1920, 1080);
    const e = Q.ed();
    await Q.importMedia([P18 + "bench-1080p30-60s.mp4"]);
    const t0 = performance.now();
    let keys = 0;
    for (let t = 0; t < 60; t++) {
      const r = Q.must(e.addGraphicLayer({ graphic: { shape: { type: t % 2 ? "ellipse" : "rectangle", width: 60, height: 60, fill: true, fillColor: `hsl(${t * 6},70%,55%)` } as never }, atFrame: 0, durationFrames: 30, visual: { transform: { x: 40 + (t % 15) * 125, y: 120 + Math.floor(t / 15) * 220 } }, name: `L${t}` }));
      // 10 clips per track, back to back, each with 5 keyframes
      let prev = r.clip;
      for (let k = 0; k < 10; k++) {
        const clip = k === 0 ? prev : Q.must(e.insertClip(r.track.id, { kind: "graphic", shape: prev.content.kind === "graphic" ? (prev.content as { shape: unknown }).shape : undefined, durationFrames: 30 } as never, k * 30, { transform: { x: 40 + (t % 15) * 125, y: 120 + Math.floor(t / 15) * 220 } })).clip;
        for (let f = 0; f < 30; f += 6) {
          Q.must(e.addKeyframe(clip.id, "visual.transform.rotation", f, f * 6));
          keys++;
        }
        prev = clip;
      }
    }
    const buildMs = Math.round(performance.now() - t0);
    const undoT = performance.now();
    for (let i = 0; i < 20; i++) e.undo();
    for (let i = 0; i < 20; i++) e.redo();
    Q.refresh();
    const undoRedo40Ms = Math.round(performance.now() - undoT);
    const preview = await Q.previewCheck([0, 75, 150, 290], "full");
    const fp = await Q.fingerprint([0, 150]);
    const save = await Q.saveAs("e4-large.clipbench");
    localStorage.setItem("qa:e4", JSON.stringify(fp));
    return { tracks: Object.keys(e.timeline.tracks).length, clips: Object.keys(e.timeline.clips).length, keys, buildMs, undoRedo40Ms, preview, save, heapMb: Q.memoryMb(), console: Q.takeConsole() };
  }
  const reopen = await Q.reopen("e4-large.clipbench");
  const saved = JSON.parse(localStorage.getItem("qa:e4") ?? "null") as { frames: { frame: number; sha: string }[] };
  const after = await Q.fingerprint([0, 150]);
  const exp = await Q.exportProject("youtube", {}, { keepBase64: false });
  return { reopen: { ms: reopen.ms, assets: reopen.assets.length }, framesEqual: saved.frames.map((f, i) => f.sha === after.frames[i].sha), exp, heapMb: Q.memoryMb(), console: Q.takeConsole() };
}

/** E5: export variants of one project (formats, codecs, sizes, rates, alpha) + cancelling mid-render. */
export async function exportVariants(variants: { name: string; preset: string; overrides: Record<string, unknown> }[]) {
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  const rows: unknown[] = [];
  for (const v of variants) rows.push({ name: v.name, ...(await Q.exportProject(v.preset as never, v.overrides as never, { keepBase64: false })) });
  // Cancel at ~30 %.
  const tl = Q.ed().timeline;
  const check = checkExportProfile(tl, presetProfile("youtube", tl));
  const ac = new AbortController();
  const t0 = performance.now();
  let cancel: unknown;
  try {
    await renderTimeline(tl, check.settings, (window as unknown as { __composition: { renderDeps: never } }).__composition.renderDeps, {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === "video" && p.done / p.total > 0.3) ac.abort();
      },
    });
    cancel = { error: "render finished although cancelled" };
  } catch (e) {
    cancel = { cancelledAfterMs: Math.round(performance.now() - t0), error: `${(e as Error).name}: ${(e as Error).message}` };
  }
  const afterCancel = await Q.exportProject("square", {}, { keepBase64: false });
  return { rows, cancel, exportAfterCancel: { ok: (afterCancel as { ok?: boolean }).ok, failed: (afterCancel as { failed?: unknown }).failed }, console: Q.takeConsole() };
}
