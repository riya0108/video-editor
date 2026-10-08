import { serializeProjectDocument } from "./document";
import { sha256Hex } from "./bundle";
import { toneWavUrl } from "../export/export-harness";
import type { ProjectManager } from "./manager";
import type { TimelineEngine } from "../timeline/engine";
import type { FinalRenderer } from "../composition/final-renderer";
import type { AIEditingSession } from "../ai/session";

/**
 * BROWSER TEST HARNESS for PROJECT_RECOVERY_TEST_REPORT.md — not used by the app. Builds a complex project through
 * the editor's own actions (media import with read handles, background removal, AI analysis, engine edits), and
 * captures a comparable fingerprint of the editor: the canonical project document, plus SHA-256 and a thumbnail of
 * full-quality rendered frames, so "reopened == saved" is checked on state AND pixels.
 *
 * Media lives in the Origin Private File System: its handles are real FileSystemFileHandles (same API and atomic
 * writable semantics as files picked with the system dialog, which automation can't drive).
 */

type W = Window & {
  __composition: { engine: TimelineEngine; finalRenderer: FinalRenderer; aiSession: AIEditingSession };
  __compositionActions: { apply: (r: unknown) => void; addMediaFiles: (f: File[], h?: (FileSystemFileHandle | undefined)[]) => Promise<void>; removeBackground: (clip: unknown) => Promise<void> };
  __project: { manager: ProjectManager };
};
const w = () => window as unknown as W;

export async function opfsDir(name: string): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

export async function writeOpfs(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array | Blob): Promise<FileSystemFileHandle> {
  const h = await dir.getFileHandle(name, { create: true });
  const wr = await h.createWritable();
  await wr.write(bytes as Blob);
  await wr.close();
  return h;
}

export async function readOpfs(h: FileSystemFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await h.getFile()).arrayBuffer());
}

const ASSETS = "/@fs/Users/teri/Downloads/Video Editor/.tmp-test-assets/phase15/";

/** Puts the test media into OPFS (user-media stand-ins) and returns their read handles. */
export async function seedMedia(): Promise<Record<"counter" | "logo" | "tone", FileSystemFileHandle>> {
  const dir = await opfsDir("media");
  const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  return {
    counter: await writeOpfs(dir, "counter30.mp4", await get(ASSETS + "counter30.mp4")),
    logo: await writeOpfs(dir, "logo-half-red.png", await get(ASSETS + "logo-half-red.png")),
    tone: await writeOpfs(dir, "tone.wav", await get(toneWavUrl())),
  };
}

const must = <T>(r: { ok: boolean; error?: Error } & T): T => {
  if (!r.ok) throw r.error;
  return r;
};

/** Adds every feature on the Phase 17 list to the open (demo) project, through the editor's own actions. */
export async function buildComplexInEditor(handles: Record<"counter" | "logo" | "tone", FileSystemFileHandle>) {
  const { engine, aiSession } = w().__composition;
  const act = w().__compositionActions;
  const ed = <T>(r: { ok: boolean; error?: Error } & T) => {
    const x = must(r);
    act.apply(r);
    return x;
  };
  const files = await Promise.all([handles.counter, handles.logo, handles.tone].map((h) => h.getFile()));
  await act.addMediaFiles(files, [handles.counter, handles.logo, handles.tone]);
  const tl = () => engine.timeline;
  const clipOn = (pred: (name: string) => boolean) => Object.values(tl().clips).find((c) => pred(tl().tracks[c.trackId].name))!;
  const main = clipOn((n) => n === "Main video");
  const counter = clipOn((n) => n === "counter30.mp4");
  const logo = clipOn((n) => n === "logo-half-red.png");
  const tone = clipOn((n) => n.includes("tone.wav"));
  const badge = clipOn((n) => n === "Badge");
  // transitions (split the main video, dissolve at the cut)
  const split = ed(engine.splitClip(main.id, 120)) as unknown as { left: { id: string }; right: { id: string } };
  ed(engine.addTransition({ fromClipId: split.left.id, toClipId: split.right.id, type: "cross-dissolve", duration: 20 }));
  // keyframes, effects, masks, crops, transforms
  ed(engine.addKeyframe(badge.id, "visual.transform.x", 0, 1500));
  ed(engine.addKeyframe(badge.id, "visual.transform.x", 150, 1750));
  ed(engine.addKeyframe(counter.id, "visual.opacity", 0, 0.4));
  ed(engine.addKeyframe(counter.id, "visual.opacity", 60, 1));
  ed(engine.addEffect(logo.id, "saturation", { amount: -0.6 }));
  ed(engine.addEffect(counter.id, "brightness", { amount: 0.15 }));
  ed(engine.addMask(counter.id, "ellipse"));
  ed(engine.setClipVisual(counter.id, { crop: { top: 0.05, left: 0.1 }, transform: { x: 480, y: 300, scaleX: 0.35, scaleY: 0.35, rotation: -4 } }));
  ed(engine.setClipVisual(logo.id, { transform: { x: 1500, y: 820, scaleX: 0.6, scaleY: 0.6 }, opacity: 0.85, blendMode: "screen" }));
  // audio
  ed(engine.setClipAudio(tone.id, { volume: 0.7, fadeInFrames: 10, fadeOutFrames: 20 }));
  // captions with word timings
  ed(engine.importCaptionCues([{ start: 0.5, end: 2.0, text: "Saved and reopened", words: [{ text: "Saved", start: 0.5, end: 0.9 }, { text: "and", start: 0.9, end: 1.2 }, { text: "reopened", start: 1.2, end: 2.0 }] }, { start: 2.2, end: 3.5, text: "every feature intact" }]));
  // text + graphics
  const title = clipOn((n) => n === "Title");
  ed(engine.updateAuthoredContent(title.id, { text: "Persistence test project" } as never));
  ed(engine.addGraphicLayer({ graphic: { shape: { type: "ellipse", width: 220, height: 140, fill: true, fillColor: "#22c55e", strokeWidth: 0, cornerRadius: 0 } as never }, atFrame: 30, durationFrames: 90, name: "Green ellipse" }));
  ed(engine.addGuide("x", 640));
  // mattes: real background removal on the uploaded image (U²-Net), stored as generated media
  await act.removeBackground(engine.timeline.clips[logo.id]);
  // AI results: a real silence analysis on the tone, then curated by hand
  await aiSession.run("silence-detection", engine.timeline.clips[tone.id]);
  let r: ReturnType<typeof aiSession.store.list>[number] | undefined;
  for (let i = 0; i < 200 && !r; i++) {
    r = aiSession.store.list().find((x) => x.feature === "silence-detection" && x.target.clipId === tone.id);
    if (!r) await new Promise((res) => setTimeout(res, 100));
  }
  if (!r) throw new Error("The silence analysis produced no result.");
  const resultId = r.id;
  if (r.items[0]) aiSession.store.updateItem(resultId, r.items[0].id, { accepted: false });
  return { counterId: counter.id, logoId: logo.id, toneId: tone.id, aiResultId: resultId, aiItems: r.items.length };
}

/** Comparable fingerprint of the editor: canonical document + rendered frames (hash and 160 px thumbnail). */
export async function editorFingerprint(frames: number[]) {
  const { engine, finalRenderer } = w().__composition;
  const { manager } = w().__project;
  const doc = manager.buildDocument(0);
  const canonical = serializeProjectDocument({ ...doc, savedAt: "", revision: 0 });
  const rendered: { frame: number; sha256: string; thumb: number[] }[] = [];
  for (const f of frames) {
    const { canvas } = await finalRenderer.renderFrame(engine.timeline, f);
    const g = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const t = new OffscreenCanvas(160, 90);
    const tg = t.getContext("2d")!;
    tg.drawImage(canvas as CanvasImageSource, 0, 0, 160, 90);
    rendered.push({ frame: f, sha256: await sha256Hex(new Uint8Array(px.buffer)), thumb: Array.from(tg.getImageData(0, 0, 160, 90).data) });
  }
  return { canonical, canonicalSha: await sha256Hex(new TextEncoder().encode(canonical)), clips: Object.keys(engine.timeline.clips).length, rendered };
}

export function psnrRgb(a: number[], b: number[]): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let c = 0; c < 3; c++) {
      se += (a[i + c] - b[i + c]) ** 2;
      n++;
    }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}
