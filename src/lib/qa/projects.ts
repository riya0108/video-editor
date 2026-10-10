import * as Q from "./qa-harness";
import { parseSubtitles } from "../captions/subtitle-io";
import * as AI from "../ai/apply";
import type { Clip } from "../timeline/clip";
import type { ExportProfile } from "../export/profile";
import type { PresetId } from "../export/presets";

/**
 * THE TEN QA PROJECTS (FULL_QA_REPORT.md §2). Each is built in the live editor the way a user would: import real
 * media, then edit. `buildProject` records every step's failure instead of stopping, so one broken feature doesn't
 * hide the rest; `finishProject` (run after a real page reload) reopens, compares, renders and exports.
 */

const P11 = ".tmp-test-assets/phase11/";
const P12 = ".tmp-test-assets/phase12/";
const P13 = ".tmp-test-assets/phase13/";
const P14 = ".tmp-test-assets/phase14/";
const P15 = ".tmp-test-assets/phase15/";
const P18 = ".tmp-test-assets/phase18/";
const P19 = ".tmp-test-assets/phase19/";
const HERO = "public/videos/hero-phone-demo.mp4";

type Step = { step: string; ok: boolean; ms: number; error?: string; info?: unknown };
type Ctx = { steps: Step[]; e: ReturnType<typeof Q.ed> };

async function step<T>(c: Ctx, name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const info = await fn();
    c.steps.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), info: summarize(info) });
    return info;
  } catch (e) {
    c.steps.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) });
    return undefined;
  }
}

function summarize(v: unknown): unknown {
  if (v && typeof v === "object" && "errors" in (v as object) && "clips" in (v as object)) return v;
  if (v && typeof v === "object" && "items" in (v as object) && "ms" in (v as object)) return { items: (v as { items: number }).items, ms: (v as { ms: number }).ms, warnings: (v as { warnings?: unknown }).warnings };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return undefined;
}

const dur = (c: Clip) => ("durationFrames" in c.content && c.content.durationFrames ? c.content.durationFrames : (c.content as { sourceOutFrame: number; sourceInFrame: number }).sourceOutFrame - (c.content as { sourceInFrame: number }).sourceInFrame);
const end = (c: Clip) => c.timelineStart + dur(c);
const visualEnd = (e: Ctx["e"]) => Math.max(0, ...Object.values(e.timeline.clips).filter((c) => c.content.kind !== "audio").map(end));

/** Trims every audio clip to end at the last visual frame (what a user does before exporting a short). */
function fitAudioToPicture(c: Ctx) {
  const last = visualEnd(c.e);
  for (const a of Object.values(c.e.timeline.clips).filter((x) => x.content.kind === "audio")) {
    if (a.timelineStart >= last) Q.must(c.e.deleteClip(a.id));
    else if (end(a) > last) Q.must(c.e.trimClip(a.id, "end", last));
  }
}

export interface ProjectSpec {
  id: string;
  title: string;
  size: [number, number];
  background?: string;
  build: (c: Ctx) => Promise<void>;
  previewFrames: number[];
  exportPreset: PresetId;
  exportOverrides?: Partial<ExportProfile>;
}

export const PROJECTS: Record<string, ProjectSpec> = {
  p2: {
    id: "p2",
    title: "Finance explainer",
    size: [1920, 1080],
    background: "#0b1220",
    previewFrames: [0, 45, 95, 150, 240, 330],
    exportPreset: "youtube",
    build: async (c) => {
      const e = c.e;
      await step(c, "import narration + b-roll + svg", () => Q.importMedia([P12 + "long-speech.m4a", P14 + "hv.mp4", P14 + "walk.mp4", P19 + "chart-icon.svg"]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "b-roll sequence with wipe", () => {
        const hv = Q.clipOn("hv.mp4");
        const walk = Q.clipOn("walk.mp4");
        Q.must(e.setClipVisual(hv.id, { fit: "cover", transform: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }));
        Q.must(e.trimClip(hv.id, "end", 180));
        // move walk onto the hv track, right after it
        Q.must(e.moveClip(walk.id, 180, hv.trackId));
        Q.must(e.setClipVisual(walk.id, { fit: "cover", transform: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }));
        Q.must(e.addTransition({ fromClipId: hv.id, toClipId: walk.id, type: "wipe", duration: 20 }));
        Q.must(e.setClipVisual(hv.id, { opacity: 0.35 }));
        Q.must(e.setClipVisual(walk.id, { opacity: 0.35 }));
      });
      await step(c, "chart bars with keyframed growth", () => {
        const vals = [0.35, 0.55, 0.42, 0.8, 0.95];
        vals.forEach((v, i) => {
          const r = Q.must(e.addGraphicLayer({ graphic: { shape: { type: "rectangle", width: 120, height: 500, fill: true, fillColor: i === 4 ? "#22c55e" : "#38bdf8", cornerRadius: 10, stroke: false } as never }, atFrame: 30, durationFrames: 270, visual: { transform: { x: 560 + i * 200, y: 860, anchorY: 1 } }, name: `Bar ${i + 1}` }));
          Q.must(e.addKeyframe(r.clip.id, "visual.transform.scaleY", 0, 0.02));
          Q.must(e.addKeyframe(r.clip.id, "visual.transform.scaleY", 24 + i * 6, v));
          Q.must(e.addTextLayer({ text: `$${Math.round(v * 120)}k`, atFrame: 54 + i * 6, durationFrames: 246 - i * 6, style: { fontSize: 44, color: "#e2e8f0" }, visual: { transform: { x: 560 + i * 200, y: 330 } }, name: `Label ${i + 1}` }));
        });
      });
      await step(c, "headline + svg icon position keyframes", () => {
        Q.must(e.addTextLayer({ text: "Where your money actually goes", atFrame: 0, durationFrames: 300, style: { fontSize: 72, color: "#ffffff", fontWeight: 800 } as never, visual: { transform: { x: 960, y: 120 } }, name: "Headline" }));
        const icon = Q.clipOn("chart-icon.svg");
        Q.must(e.setClipVisual(icon.id, { transform: { x: 200, y: 140, scaleX: 1, scaleY: 1 } }));
        Q.must(e.addKeyframe(icon.id, "visual.transform.rotation", 0, -10));
        Q.must(e.addKeyframe(icon.id, "visual.transform.rotation", 60, 10));
      });
      await step(c, "narration levels", () => {
        const n = Q.clipOn("long-speech");
        Q.must(e.setClipAudio(n.id, { gainDb: 3, fadeOutFrames: 15 }));
        Q.must(e.trimClip(n.id, "end", 360));
      });
      fitAudioToPicture(c);
    },
  },
  p3: {
    id: "p3",
    title: "Product advertisement",
    size: [1080, 1080],
    background: "#fafaf9",
    previewFrames: [0, 20, 60, 100, 140, 170],
    exportPreset: "square",
    build: async (c) => {
      const e = c.e;
      await step(c, "import product + backdrop + music + sfx", () => Q.importMedia([P15 + "logo-half-red.png", "public/images/bg-removal-office.webp", P11 + "epic-music.mp3", P11 + "whoosh-sfx.wav"]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "backdrop with vignette + blur", () => {
        const bg = Q.clipOn("bg-removal-office");
        Q.must(e.setClipVisual(bg.id, { fit: "cover", transform: { x: 540, y: 540, scaleX: 1, scaleY: 1 } }));
        Q.must(e.trimClip(bg.id, "end", 180));
        Q.must(e.addEffect(bg.id, "blur", { radius: 12 }));
        Q.must(e.addEffect(bg.id, "vignette", { amount: 0.6 }));
        // A multi-file drop stacks the LAST file frontmost: send the backdrop behind the product, as a user would.
        Q.must(e.reorderTrack(bg.trackId, e.timeline.trackIds.indexOf(Q.clipOn("logo-half-red").trackId)));
      });
      await step(c, "product hero: scale/rotation keyframes + glow + shadowed card", () => {
        const p = Q.clipOn("logo-half-red");
        Q.must(e.trimClip(p.id, "end", 180));
        Q.must(e.addKeyframe(p.id, "visual.transform.scaleX", 0, 0.2));
        Q.must(e.addKeyframe(p.id, "visual.transform.scaleY", 0, 0.2));
        Q.must(e.addKeyframe(p.id, "visual.transform.scaleX", 18, 1.1));
        Q.must(e.addKeyframe(p.id, "visual.transform.scaleY", 18, 1.1));
        Q.must(e.addKeyframe(p.id, "visual.transform.rotation", 0, -25));
        Q.must(e.addKeyframe(p.id, "visual.transform.rotation", 18, 0));
        Q.must(e.addEffect(p.id, "glow", { radius: 18, intensity: 0.6, threshold: 0.5 }));
      });
      await step(c, "callouts with push transition", () => {
        const a = Q.must(e.addTextLayer({ text: "NEW", atFrame: 20, durationFrames: 60, style: { fontSize: 120, color: "#dc2626", fontFamily: "anton" } as never, visual: { transform: { x: 540, y: 180 } }, name: "Callout" }));
        const r = Q.must(e.insertClip(a.track.id, { kind: "text", text: "50% OFF", durationFrames: 100, textStyle: { fontSize: 120, color: "#111827", fontFamily: "anton" } as never }, 80, { transform: { x: 540, y: 180 } }));
        Q.must(e.addTransition({ fromClipId: a.clip.id, toClipId: r.clip.id, type: "push", duration: 12 }));
        Q.must(e.addGraphicLayer({ graphic: { shape: { type: "rectangle", width: 640, height: 110, fill: true, fillColor: "#111827", cornerRadius: 55, stroke: false, shadow: true, shadowBlur: 20, shadowOffsetX: 0, shadowOffsetY: 8, shadowColor: "rgba(0,0,0,0.4)" } as never }, atFrame: 100, durationFrames: 80, visual: { transform: { x: 540, y: 930 } }, name: "CTA pill" }));
        Q.must(e.addTextLayer({ text: "Shop now →", atFrame: 100, durationFrames: 80, style: { fontSize: 56, color: "#ffffff" }, visual: { transform: { x: 540, y: 930 } }, name: "CTA" }));
      });
      await step(c, "sfx at product reveal + music bed", () => {
        Q.must(e.setClipAudio(Q.clipOn("epic-music").id, { volume: 0.4, fadeOutFrames: 20 }));
        Q.must(e.setClipAudio(Q.clipOn("whoosh").id, { volume: 0.9 }));
      });
      fitAudioToPicture(c);
    },
  },
  p4: {
    id: "p4",
    title: "Background-removal Reel",
    size: [1080, 1920],
    previewFrames: [0, 60, 120, 200],
    exportPreset: "instagram-reel",
    build: async (c) => {
      const e = c.e;
      await step(c, "import person photo, backdrop, talking-head video", () => Q.importMedia(["public/images/bg-removal-office.webp", "public/images/bg-removal-person.webp", HERO]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "layout", () => {
        const bg = Q.clipOn("bg-removal-office");
        Q.must(e.setClipVisual(bg.id, { fit: "cover", transform: { x: 540, y: 960, scaleX: 1, scaleY: 1 } }));
        Q.must(e.trimClip(bg.id, "end", 240));
        const person = Q.clipOn("bg-removal-person");
        Q.must(e.setClipVisual(person.id, { fit: "contain", transform: { x: 540, y: 1300, scaleX: 0.9, scaleY: 0.9 } }));
        Q.must(e.trimClip(person.id, "end", 120));
        const v = Q.clipOn("hero-phone-demo");
        Q.must(e.moveClip(v.id, 120));
        Q.must(e.setClipVisual(v.id, { fit: "contain", transform: { x: 540, y: 1100, scaleX: 0.8, scaleY: 0.8 } }));
      });
      await step(c, "remove background: photo (U2-Net)", async () => {
        await (window as unknown as { __compositionActions: { removeBackground: (c: Clip) => Promise<void> } }).__compositionActions.removeBackground(Q.clipOn("bg-removal-person"));
        const v = Q.clipOn("bg-removal-person").visual;
        if (!v?.matte) throw new Error("No matte was attached to the photo.");
        return "matte attached";
      });
      await step(c, "remove background: video (per-frame matte)", async () => {
        await (window as unknown as { __compositionActions: { removeBackground: (c: Clip) => Promise<void> } }).__compositionActions.removeBackground(Q.clipOn("hero-phone-demo"));
        const v = Q.clipOn("hero-phone-demo").visual;
        if (!v?.matte) throw new Error("No matte was attached to the video.");
        return "matte attached";
      });
      await step(c, "title", () => Q.must(e.addTextLayer({ text: "Teleported to the office", atFrame: 0, durationFrames: 240, style: { fontSize: 72, color: "#ffffff", stroke: true, strokeColor: "#000", strokeWidth: 5 }, visual: { transform: { x: 540, y: 240 } }, name: "Title" })));
      fitAudioToPicture(c);
    },
  },
  p5: {
    id: "p5",
    title: "Caption-heavy Reel",
    size: [1080, 1920],
    previewFrames: [10, 60, 120, 200, 3000, 7000],
    exportPreset: "youtube-shorts",
    exportOverrides: {},
    build: async (c) => {
      const e = c.e;
      await step(c, "import talking head", () => Q.importMedia([HERO]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "full-frame", () => Q.must(e.setClipVisual(Q.clipOn("hero-phone-demo").id, { fit: "cover", transform: { x: 540, y: 960, scaleX: 1, scaleY: 1 } })));
      await step(c, "auto-captions (Whisper, short-form)", async () => {
        const before = Object.values(e.timeline.clips).filter((x) => x.content.kind === "caption").length;
        await (window as unknown as { __compositionActions: { generateCaptions: (o: unknown) => Promise<void> } }).__compositionActions.generateCaptions({ language: "en", tier: "fast", profile: "short-form", scope: "timeline", replace: true });
        const after = Object.values(e.timeline.clips).filter((x) => x.content.kind === "caption");
        if (after.length <= before) throw new Error(`No captions were generated (notice: ${document.body.innerText.match(/Generated[^\n]*|No speech[^\n]*|Captioning failed[^\n]*|There.s no audible[^\n]*/)?.[0] ?? "none"}).`);
        return `${after.length} captions: "${after.slice(0, 3).map((x) => (x.content as { text?: string }).text).join(" | ")}"`;
      });
      await step(c, "caption style preset + speaker colour", () => {
        const t = Object.values(e.timeline.tracks).find((x) => x.kind === "caption")!;
        Q.must(e.applyCaptionPreset(t.id, "creator"));
      });
      await step(c, "second caption track: 150-cue SRT (translation-style)", async () => {
        const text = await (await fetch(Q.ROOT + P19 + "heavy-150.srt")).text();
        const cues = parseSubtitles(text, "heavy-150.srt");
        const r = Q.must(e.importCaptionCues(cues.cues, { name: "Subtitles (SRT)" }));
        Q.must(e.applyCaptionPreset(r.trackId, "boxed"));
        return `${r.clips.length} cues`;
      });
      await step(c, "messy SRT + speakers VTT", async () => {
        const out: string[] = [];
        for (const f of ["messy.srt", "speakers.vtt"]) {
          const text = await (await fetch(Q.ROOT + P12 + f)).text();
          const cues = parseSubtitles(text, f);
          const r = Q.must(e.importCaptionCues(cues.cues, { name: f }));
          out.push(`${f}: ${r.clips.length} cues, ${r.adjusted} adjusted`);
        }
        return out.join("; ");
      });
    },
  },
  p6: {
    id: "p6",
    title: "Podcast clip",
    size: [1080, 1080],
    background: "#111827",
    previewFrames: [0, 300, 900, 1700],
    exportPreset: "square",
    build: async (c) => {
      const e = c.e;
      await step(c, "import 31-min podcast WAV, 2-speaker interview, cover image", () => Q.importMedia([P11 + "long-podcast-31min.wav", P14 + "interview-2spk.wav", P14 + "office_bg.png"]));
      // The 31-minute file is refused (30-minute decode limit, KNOWN_ISSUES.md): the workaround the message suggests — a shorter export of the episode.
      await step(c, "import the 25-min cut of the episode", () => Q.importMedia([P19 + "podcast-25min.wav"]));
      await step(c, "audio settled", () => Q.audioSettled(300_000));
      await step(c, "cut a 60 s segment from the long episode (minute 12)", () => {
        const pod = Q.clipOn("podcast-25min");
        Q.must(e.trimClip(pod.id, "start", 0 + 12 * 60 * 30));
        const p2 = Q.clipOn("podcast-25min");
        Q.must(e.moveClip(p2.id, 0));
        Q.must(e.trimClip(Q.clipOn("podcast-25min").id, "end", 1800));
        return `${dur(Q.clipOn("podcast-25min"))} frames`;
      });
      await step(c, "interview after it; levels", () => {
        const iv = Q.clipOn("interview-2spk");
        Q.must(e.moveClip(iv.id, 1800));
        Q.must(e.setClipAudio(iv.id, { gainDb: -2, fadeInFrames: 10 }));
        Q.must(e.setClipAudio(Q.clipOn("podcast-25min").id, { fadeOutFrames: 30 }));
      });
      await step(c, "cover art + episode title + progress bar", () => {
        const img = Q.clipOn("office_bg");
        Q.must(e.setClipVisual(img.id, { fit: "cover", transform: { x: 540, y: 540, scaleX: 1, scaleY: 1 } }));
        Q.must(e.addEffect(img.id, "exposure", { stops: -1 }));
        Q.must(e.trimClip(img.id, "end", visualOrAudioEnd(c)));
        Q.must(e.addTextLayer({ text: "EP 42 · Building in public", atFrame: 0, durationFrames: visualOrAudioEnd(c), style: { fontSize: 64, color: "#f9fafb" }, visual: { transform: { x: 540, y: 160 } }, name: "Episode" }));
        const bar = Q.must(e.addGraphicLayer({ graphic: { shape: { type: "rectangle", width: 960, height: 14, fill: true, fillColor: "#f59e0b", cornerRadius: 7, stroke: false } as never }, atFrame: 0, durationFrames: visualOrAudioEnd(c), visual: { transform: { x: 60, y: 1000, anchorX: 0 } }, name: "Progress" }));
        Q.must(e.addKeyframe(bar.clip.id, "visual.transform.scaleX", 0, 0.001));
        Q.must(e.addKeyframe(bar.clip.id, "visual.transform.scaleX", visualOrAudioEnd(c) - 1, 1));
      });
      await step(c, "AI speaker detection on the interview", () => Q.runAI("speaker-detection", Q.clipOn("interview-2spk")));
    },
  },
  p7: {
    id: "p7",
    title: "Music montage",
    size: [1920, 1080],
    previewFrames: [0, 40, 90, 140, 190, 240, 290],
    exportPreset: "youtube",
    build: async (c) => {
      const e = c.e;
      const shots = ["s1.mp4", "s2.mp4", "s3.mp4", "s4.mp4", "s5.mp4", "walk.mp4", "h1.mp4", "h2.mp4", "h3.mp4"];
      await step(c, "import 9 clips + music + ambience", () => Q.importMedia([...shots.map((s) => P14 + s), P11 + "epic-music.mp3", P11 + "rain-ambience.flac"]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "cut to the beat on one track (1.2 s per shot)", () => {
        const first = Q.clipOn("s1.mp4");
        let t = 0;
        for (const s of shots) {
          const clip = Q.clipOn(s);
          const len = 36;
          if (dur(clip) > len) Q.must(e.trimClip(clip.id, "end", clip.timelineStart + len));
          Q.must(e.moveClip(clip.id, t, first.trackId));
          Q.must(e.setClipVisual(clip.id, { fit: "cover", transform: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }));
          t += 36;
        }
        // remove now-empty tracks
        for (const tr of Object.values(e.timeline.tracks)) if (tr.clipIds.length === 0) Q.must(e.removeTrack(tr.id));
        return `${t} frames`;
      });
      await step(c, "every transition type between shots", () => {
        const types = ["cut", "fade", "dissolve", "cross-dissolve", "slide", "push", "wipe", "zoom"];
        const track = Q.clipOn("s1.mp4").trackId;
        const clips = e.timeline.tracks[track].clipIds.map((id) => e.timeline.clips[id]).sort((a, b) => a.timelineStart - b.timelineStart);
        for (let i = 0; i < clips.length - 1; i++) Q.must(e.addTransition({ fromClipId: clips[i].id, toClipId: clips[i + 1].id, type: types[i % types.length], duration: 10 }));
        return `${clips.length - 1} transitions`;
      });
      await step(c, "grade every shot (temperature + contrast + grain)", () => {
        for (const id of e.timeline.tracks[Q.clipOn("s1.mp4").trackId].clipIds) {
          Q.must(e.addEffect(id, "temperature", { amount: 0.2 }));
          Q.must(e.addEffect(id, "contrast", { amount: 0.15 }));
          Q.must(e.addEffect(id, "grain", { amount: 0.15 }));
        }
      });
      await step(c, "music + ambience mix", () => {
        Q.must(e.setClipAudio(Q.clipOn("epic-music").id, { volume: 0.9, fadeInFrames: 10, fadeOutFrames: 45 }));
        Q.must(e.setClipAudio(Q.clipOn("rain-ambience").id, { volume: 0.25 }));
      });
      fitAudioToPicture(c);
    },
  },
  p8: {
    id: "p8",
    title: "Image slideshow",
    size: [1920, 1080],
    previewFrames: [0, 50, 100, 200, 300, 400],
    exportPreset: "youtube",
    build: async (c) => {
      const e = c.e;
      const imgs = [P14 + "hero_0.5.png", P14 + "hero_2.png", P14 + "w_0.png", P14 + "w_2.png", P14 + "office_bg.png", P14 + "tv_1.png", P13 + "bg-removed-over-magenta.png", ".tmp-test-assets/test-image.jpg", "public/images/bg-removal-person.webp", P19 + "hero-frame.png", P14 + "f_1.95.png", P14 + "removal-before-after.png"];
      await step(c, "import 12 images + music", () => Q.importMedia([...imgs, P11 + "epic-music.mp3"]));
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "Ken Burns: 12 slides × 2 s on one track, scale+pan keyframes", () => {
        const names = imgs.map((p) => p.split("/").pop()!.replace(/\.[^.]+$/, ""));
        const first = Q.clipOn(names[0]);
        names.forEach((n, i) => {
          const c0 = Q.clipOn(n);
          Q.must(e.trimClip(c0.id, "end", c0.timelineStart + 60));
          Q.must(e.moveClip(c0.id, i * 60, first.trackId));
          Q.must(e.setClipVisual(c0.id, { fit: "cover", transform: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }));
          Q.must(e.addKeyframe(c0.id, "visual.transform.scaleX", 0, 1));
          Q.must(e.addKeyframe(c0.id, "visual.transform.scaleY", 0, 1));
          Q.must(e.addKeyframe(c0.id, "visual.transform.scaleX", 59, 1.12));
          Q.must(e.addKeyframe(c0.id, "visual.transform.scaleY", 59, 1.12));
          Q.must(e.addKeyframe(c0.id, "visual.transform.x", 0, i % 2 ? 900 : 1020));
          Q.must(e.addKeyframe(c0.id, "visual.transform.x", 59, i % 2 ? 1020 : 900));
        });
        for (const tr of Object.values(e.timeline.tracks)) if (tr.clipIds.length === 0) Q.must(e.removeTrack(tr.id));
      });
      await step(c, "cross-dissolves", () => {
        const track = Q.clipOn("hero_0.5").trackId;
        const clips = e.timeline.tracks[track].clipIds.map((id) => e.timeline.clips[id]).sort((a, b) => a.timelineStart - b.timelineStart);
        for (let i = 0; i < clips.length - 1; i++) Q.must(e.addTransition({ fromClipId: clips[i].id, toClipId: clips[i + 1].id, type: "cross-dissolve", duration: 15 }));
      });
      await step(c, "music fade", () => Q.must(e.setClipAudio(Q.clipOn("epic-music").id, { fadeInFrames: 20, fadeOutFrames: 60 })));
      fitAudioToPicture(c);
    },
  },
  p9: {
    id: "p9",
    title: "Multi-layer composition (transparent)",
    size: [1920, 1080],
    background: "transparent",
    previewFrames: [0, 30, 75, 120, 170],
    exportPreset: "custom",
    exportOverrides: { container: "webm", videoCodec: "vp9", alpha: true, audioCodec: "opus", width: 1920, height: 1080, fps: 30 } as Partial<ExportProfile>,
    build: async (c) => {
      const e = c.e;
      await step(c, "import videos, alpha WebM, alpha PNGs, 6 audio files", () =>
        Q.importMedia([P18 + "bench-1080p30-60s.mp4", P18 + "alpha.webm", P15 + "logo-half-red.png", P13 + "bg-removed-over-magenta.png", P19 + "chart-icon.svg", P14 + "t1.wav", P14 + "t2.wav", P14 + "t3.wav", P11 + "whoosh-sfx.wav", P11 + "rain-ambience.flac", P11 + "narration-voiceover.m4a", P19 + "voice-memo.webm"]),
      );
      await step(c, "audio settled", () => Q.audioSettled());
      await step(c, "20 shape layers in a grid, every blend mode", () => {
        const modes = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add", "normal", "screen", "overlay"];
        modes.forEach((m, i) => Q.must(e.addGraphicLayer({ graphic: { shape: { type: i % 3 === 0 ? "ellipse" : i % 3 === 1 ? "rectangle" : "polygon", sides: 6, width: 220, height: 160, fill: true, fillColor: `hsl(${i * 18},80%,55%)`, stroke: i % 2 === 0, strokeColor: "#fff", strokeWidth: 4, cornerRadius: 16 } as never }, atFrame: 0, durationFrames: 180, visual: { blendMode: m as never, opacity: 0.85, transform: { x: 200 + (i % 5) * 380, y: 160 + Math.floor(i / 5) * 240 } }, name: `Shape ${i}` })));
      });
      await step(c, "many keyframes: 20 layers × 4 properties × 12 keys", () => {
        const shapes = Object.values(e.timeline.clips).filter((x) => e.timeline.tracks[x.trackId].name.startsWith("Shape"));
        let n = 0;
        for (const s of shapes)
          for (let k = 0; k < 12; k++) {
            const f = k * 15;
            Q.must(e.addKeyframe(s.id, "visual.transform.rotation", f, (k % 2 ? 1 : -1) * 15));
            Q.must(e.addKeyframe(s.id, "visual.opacity", f, k % 2 ? 0.5 : 1));
            Q.must(e.addKeyframe(s.id, "visual.transform.scaleX", f, 1 + (k % 3) * 0.1));
            Q.must(e.addKeyframe(s.id, "visual.transform.scaleY", f, 1 + (k % 3) * 0.1));
            n += 4;
          }
        return `${n} keyframes`;
      });
      await step(c, "masks: rectangle, ellipse, polygon, freeform; feather; modes", () => {
        const v = Q.clipOn("bench-1080p30-60s");
        Q.must(e.trimClip(v.id, "end", 180));
        Q.must(e.setClipVisual(v.id, { fit: "contain", transform: { x: 960, y: 540, scaleX: 0.6, scaleY: 0.6 } }));
        const m1 = Q.must(e.addMask(v.id, "ellipse"));
        Q.must(e.updateMask(v.id, m1.mask.id, { feather: 30 }));
        Q.must(e.addMask(v.id, "rectangle", { mode: "subtract", patch: { feather: 10 } as never }));
        const logo = Q.clipOn("logo-half-red");
        Q.must(e.trimClip(logo.id, "end", 180));
        Q.must(e.addMask(logo.id, "polygon"));
        const cut = Q.clipOn("bg-removed-over-magenta");
        Q.must(e.trimClip(cut.id, "end", 180));
        Q.must(e.addMask(cut.id, "freeform", { layerPoints: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 0.2, y: 0.7 }] as never }));
        Q.must(e.setClipVisual(cut.id, { transform: { x: 400, y: 800, scaleX: 0.4, scaleY: 0.4 } }));
      });
      await step(c, "effect stack ×6 on the video", () => {
        const id = Q.clipOn("bench-1080p30-60s").id;
        for (const [t, p] of [["brightness", { amount: 0.05 }], ["contrast", { amount: 0.2 }], ["saturation", { amount: 0.3 }], ["sharpen", { radius: 2, amount: 0.4 }], ["vignette", { amount: 0.5 }], ["glow", { radius: 8, intensity: 0.3, threshold: 0.7 }]] as const) Q.must(e.addEffect(id, t, p));
      });
      await step(c, "alpha WebM + svg placement", () => {
        const a = Q.clipOn("alpha.webm");
        Q.must(e.setClipVisual(a.id, { transform: { x: 1600, y: 850, scaleX: 1, scaleY: 1 } }));
        Q.must(e.setClipVisual(Q.clipOn("chart-icon").id, { transform: { x: 1750, y: 120 } }));
      });
      await step(c, "6 audio tracks: mute/solo/volume/pan-ish gain", () => {
        Q.must(e.setClipAudio(Q.clipOn("t1.wav").id, { volume: 0.6 }));
        Q.must(e.setClipAudio(Q.clipOn("t2.wav").id, { gainDb: -6 }));
        Q.must(e.setTrackMuted(Q.clipOn("t3.wav").trackId, true));
        Q.must(e.setClipAudio(Q.clipOn("narration").id, { fadeInFrames: 15 }));
        return `${Object.values(e.timeline.tracks).filter((t) => t.kind === "audio").length} audio tracks`;
      });
      fitAudioToPicture(c);
      await step(c, "layer count", () => `${Object.keys(e.timeline.tracks).length} tracks, ${Object.keys(e.timeline.clips).length} clips`);
    },
  },
  p10: {
    id: "p10",
    title: "AI-assisted project",
    size: [1080, 1920],
    previewFrames: [0, 60, 150, 250],
    exportPreset: "youtube-shorts",
    build: async (c) => {
      const e = c.e;
      await step(c, "import landscape multi-shot video, filler-heavy speech, gapped audio", () => Q.importMedia([P14 + "multishot.mp4", P14 + "speech-fillers.wav", P14 + "mono-1spk.wav"]));
      await step(c, "audio settled", () => Q.audioSettled());
      const ms = () => Q.clipOn("multishot");
      await step(c, "full-frame (cover) in a 9:16 composition", () => Q.must(e.setClipVisual(ms().id, { fit: "cover", transform: { x: 540, y: 960, scaleX: 1, scaleY: 1 } })));
      const shots = await step(c, "AI shot detection", () => Q.runAI("shot-detection", ms()));
      await step(c, "apply: split at shot boundaries", () => {
        if (!shots || !("result" in shots) || !shots.result) throw new Error(`no result: ${JSON.stringify(shots)?.slice(0, 120)}`);
        Q.applyAI((tl) => AI.splitAtBoundaries(tl, shots.result!).timeline);
        return `${Object.values(e.timeline.clips).filter((x) => x.content.kind === "video" || x.content.kind === "overlay").length} video clips`;
      });
      const faces = await step(c, "AI face detection (first shot)", () => Q.runAI("face-detection", ms()));
      const reframe = await step(c, "AI auto-reframe (first shot)", () => Q.runAI("auto-reframe", ms()));
      await step(c, "apply reframe", () => {
        if (!reframe || !("result" in reframe) || !reframe.result) throw new Error(`no result: ${JSON.stringify(reframe)?.slice(0, 120)}`);
        Q.applyAI((tl) => AI.applyReframe(tl, reframe.result!, { width: 1280, height: 720 }).timeline);
      });
      const fillers = await step(c, "AI filler-word detection", () => Q.runAI("filler-detection", Q.clipOn("speech-fillers")));
      await step(c, "apply: cut fillers, close gaps", () => {
        if (!fillers || !("result" in fillers) || !fillers.result) throw new Error(`no result: ${JSON.stringify(fillers)?.slice(0, 120)}`);
        Q.applyAI((tl) => AI.removeRanges(tl, fillers.result!, { closeGaps: true }).timeline);
      });
      const sil = await step(c, "AI silence detection", () => Q.runAI("silence-detection", Q.clipOn("mono-1spk")));
      await step(c, "apply: remove silences", () => {
        if (!sil || !("result" in sil) || !sil.result) throw new Error(`no result: ${JSON.stringify(sil)?.slice(0, 120)}`);
        Q.applyAI((tl) => AI.removeRanges(tl, sil.result!, { closeGaps: true }).timeline);
      });
      await step(c, "AI highlight detection", () => Q.runAI("highlight-detection", ms()));
      void faces;
      fitAudioToPicture(c);
    },
  },
};

function visualOrAudioEnd(c: Ctx) {
  return Math.max(1, ...Object.values(c.e.timeline.clips).map(end));
}

/** Build → preview → fingerprint → save. Results are kept in localStorage for the after-reload half. */
export async function buildProject(id: string) {
  const spec = PROJECTS[id];
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  const c: Ctx = { steps: [], e: Q.ed() };
  const t0 = performance.now();
  Q.newProject(spec.size[0], spec.size[1], spec.background ?? "#000000");
  await spec.build(c);
  Q.refresh();
  const buildMs = Math.round(performance.now() - t0);
  const frames = spec.previewFrames.filter((f) => f < Math.max(1, ...Object.values(c.e.timeline.clips).map(end)));
  const preview = await Q.previewCheck(frames).catch((e) => ({ error: (e as Error).message }));
  const fp = await Q.fingerprint(frames).catch((e) => ({ error: (e as Error).message }));
  const save = await Q.saveAs(`${id}.clipbench`).catch((e) => ({ error: (e as Error).message }));
  const out = { id, title: spec.title, buildMs, steps: c.steps, tracks: Object.keys(c.e.timeline.tracks).length, clips: Object.keys(c.e.timeline.clips).length, durationSec: +(Math.max(0, ...Object.values(c.e.timeline.clips).map(end)) / 30).toFixed(2), preview, fp, save, heapMb: Q.memoryMb(), console: Q.takeConsole() };
  localStorage.setItem(`qa:${id}`, JSON.stringify({ fp, frames }));
  return out;
}

/** After a page reload: reopen → compare → contact sheet → export. */
export async function finishProject(id: string, opts: { keepBase64?: boolean; sheetFrames?: number[] } = {}) {
  const spec = PROJECTS[id] ?? { exportPreset: "youtube" as PresetId, exportOverrides: {} };
  await Q.ready();
  Q.hookConsole();
  Q.takeConsole();
  const saved = JSON.parse(localStorage.getItem(`qa:${id}`) ?? "null") as { fp: { frames: { frame: number; sha: string }[] }; frames: number[] } | null;
  const reopen = await Q.reopen(`${id}.clipbench`).catch((e) => ({ error: (e as Error).message }));
  const audio = await Q.audioSettled(300_000);
  const diffs = await Q.diffAgainstSavedFile(`${id}.clipbench`).catch((e) => [`error: ${(e as Error).message}`]);
  let framesEqual: (boolean | string)[] = [];
  if (saved?.frames?.length) {
    const after = await Q.fingerprint(saved.frames).catch((e) => ({ error: (e as Error).message }));
    framesEqual = "frames" in after ? saved.fp.frames.map((f, i) => f.sha === after.frames[i]?.sha) : [String((after as { error: string }).error)];
  }
  const sheet = await Q.contactSheet(opts.sheetFrames ?? saved?.frames ?? [0], 300).catch((e) => `error: ${(e as Error).message}`);
  const exp = await Q.exportProject(spec.exportPreset, spec.exportOverrides ?? {}, { keepBase64: opts.keepBase64 ?? true });
  return { id, reopen, audio, diffs, framesEqual, sheet, exp, heapMb: Q.memoryMb(), console: Q.takeConsole() };
}
