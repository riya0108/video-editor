import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { TimelineModel } from "../timeline/model";
import { evaluateTrack } from "../animation/keyframes";
import { activeTransitionAt, transitionsByTrack } from "../transitions/model";
import type { ProbeLayout } from "../render/probe-project";
import type { RenderPlan } from "../render/plan";
import type { RenderReport } from "../render/validate";
import type { ExportProfile } from "./profile";

/**
 * REAL EXPORT EVALUATION (EXPORT_TEST_REPORT.md). Every file the browser exported through the production ExportQueue
 * (`.tmp-test-assets/phase16/final/e-*.{mp4,mov,webm}` + `.meta.json`, git-ignored — skipped where absent) is checked
 * with an INDEPENDENT decoder, ffmpeg, against the profile that was asked for and the timeline that was rendered:
 * container, codec, size, frame count, fps, duration, bitrate, audio codec/format/exact sample count/sync, the source
 * frame every output frame shows (through the framing placement), letterbox bars, fill crop geometry, and alpha.
 * It also checks the job outcomes: completed only with a fully passing report, cancelled with no file, refused
 * combinations never queued.
 */
const DIR = join(process.cwd(), ".tmp-test-assets", "phase16", "final");
const metas = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^e-.*\.meta\.json$/.test(f)).map((f) => f.replace(/\.meta\.json$/, "")) : [];

interface Meta {
  status?: string;
  history?: string[];
  error?: string | null;
  refused?: string[];
  report: RenderReport | null;
  plan: RenderPlan | null;
  profile: ExportProfile;
  layout: ProbeLayout;
  timeline: TimelineModel;
}

const load = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.meta.json`), "utf8")) as Meta;
const ff = (args: string[], maxBuffer = 1 << 30) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { maxBuffer });
const probeJson = (args: string[]) => JSON.parse(execFileSync("ffprobe", ["-v", "error", ...args, "-of", "json"], { maxBuffer: 1 << 28 }).toString());
const FF_CODEC: Record<string, string> = { avc: "h264", hevc: "hevc", vp9: "vp9", av1: "av1", vp8: "vp8", aac: "aac", opus: "opus" };
/** ffmpeg's native VP8/VP9 decoders drop the alpha side stream; libvpx keeps it. */
const ALPHA_DECODER: Record<string, string> = { vp9: "libvpx-vp9", vp8: "libvpx" };

describe.skipIf(metas.length === 0)("real exports, checked by ffmpeg", () => {
  it("job outcomes: every completed job has a fully passing report; cancelled/refused jobs produced no file", () => {
    const by = Object.fromEntries(metas.map((n) => [n, load(n)]));
    for (const [n, m] of Object.entries(by)) {
      if (m.refused) {
        expect(m.status, n).toBeUndefined();
        continue;
      }
      expect(m.history![0], n).toBe("queued");
      expect(m.history![1], n).toBe("processing");
      if (m.status === "completed") expect(m.report!.checks.every((c) => c.ok), n).toBe(true);
      if (m.status === "cancelled") expect(existsSync(join(DIR, `${n}.${m.profile.container}`)), n).toBe(false);
    }
    expect(by["e-cancel-mid"]?.status).toBe("cancelled");
    expect(by["e-refused-hevc-webm"]?.refused?.[0]).toMatch(/HEVC.*can't go in WEBM/);
    expect(by["e-refused-opus-mp4"]?.refused?.[0]).toMatch(/Opus audio can't go in MP4/);
    expect(by["e-preflight-aac-384"]).toMatchObject({ status: "failed", error: expect.stringMatching(/fails at 384 kbit\/s/) });
  });

  for (const name of metas) {
    const meta = load(name);
    if (meta.status !== "completed") continue;
    describe(name, () => {
      const { plan, profile: P0, layout: L, timeline: tl } = meta as Required<Meta> & { plan: RenderPlan };
      const file = join(DIR, `${name}.${P0.container}`);
      const { width: W, height: H, fps } = plan.settings;
      const P = plan.placement;
      const s = P.scale;
      const alphaVariant = tl.composition.background === "transparent";
      const tlFrame = (k: number) => (k * plan.projectFps) / fps;
      const frameRgba = (k: number): Uint8Array => {
        const dec = plan.settings.alpha ? ["-c:v", ALPHA_DECODER[P0.videoCodec]] : [];
        const buf = ff([...dec, "-i", file, "-vf", `select=eq(n\\,${k})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
        expect(buf.length).toBe(W * H * 4);
        return buf;
      };
      /** Pixel at COMPOSITION coordinates (mapped through the placement). */
      const at = (img: Uint8Array, cx: number, cy: number) => {
        const x = Math.round(P.x + cx * s);
        const y = Math.round(P.y + cy * s);
        const o = (y * W + x) * 4;
        return [img[o], img[o + 1], img[o + 2], img[o + 3]];
      };

      it("container, video codec, size, exact frame count, fps, duration", () => {
        const head = readFileSync(file).subarray(0, 64);
        if (P0.container === "webm") expect(head.includes(Buffer.from("webm"))).toBe(true);
        else expect(head.subarray(8, 12).toString("latin1")).toBe(P0.container === "mov" ? "qt  " : "isom");
        const v = probeJson(["-count_frames", "-select_streams", "v", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_frames", file]).streams[0];
        expect(v.codec_name).toBe(FF_CODEC[P0.videoCodec]);
        expect([v.width, v.height]).toEqual([P0.width, P0.height]);
        expect(Number(v.nb_read_frames)).toBe(plan.frameCount);
        expect(v.r_frame_rate).toBe(`${P0.fps}/1`);
        const pts = probeJson(["-select_streams", "v", "-show_entries", "packet=pts_time,size", file]).packets as { pts_time: string; size: string }[];
        const ts = pts.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
        ts.forEach((t, i) => expect(Math.abs(t - i / fps)).toBeLessThan(0.1 / fps + 0.0005));
        // Bitrate from the packets themselves, against the profile's target.
        const bps = (pts.reduce((a, p) => a + Number(p.size), 0) * 8) / plan.durationSec;
        expect(bps).toBeGreaterThan(0);
        expect(bps).toBeLessThanOrEqual(plan.settings.videoBitrate * 1.5);
      });

      it("audio: codec, 48 kHz stereo, exact length (WebM: under one Opus frame of padding), beeps in sync", () => {
        const streams = probeJson(["-select_streams", "a", "-show_entries", "stream=codec_name,sample_rate,channels", file]).streams;
        if (P0.audioCodec === "none") {
          expect(streams).toEqual([]);
          return;
        }
        expect(streams[0]).toMatchObject({ codec_name: FF_CODEC[P0.audioCodec], sample_rate: "48000", channels: 2 });
        const pcm = ff(["-i", file, "-map", "0:a", "-ac", "1", "-f", "f32le", "-"]);
        const n = pcm.length / 4;
        if (P0.container === "webm") {
          expect(n).toBeGreaterThanOrEqual(plan.audioSamples);
          expect(n).toBeLessThan(plan.audioSamples + 960);
        } else expect(n).toBe(plan.audioSamples);
        const x = new Float32Array(pcm.buffer, pcm.byteOffset, n);
        const onsets: number[] = [];
        let on = false;
        for (let i = 0; i < x.length; i += 8) {
          let e = 0;
          for (let j = i; j < Math.min(x.length, i + 8); j++) e = Math.max(e, Math.abs(x[j]));
          if (e > 0.25 && !on) onsets.push(i / 48000);
          on = e > 0.25;
        }
        expect(onsets.length).toBe(L.audio.beepsSec.length);
        onsets.forEach((t, i) => expect(Math.abs(t - L.audio.beepsSec[i])).toBeLessThan(0.001));
      });

      it.skipIf(alphaVariant || plan.settings.framing === "fill")("every output frame shows the right SOURCE frame (counter), through the placement", () => {
        const transitions = transitionsByTrack(tl);
        const videoTrack = tl.trackIds.find((id) => tl.tracks[id].name === "video")!;
        const rows = Math.floor(L.counterRows * s * 0.9);
        const raw = ff(["-i", file, "-vf", `crop=${P.width}:${rows}:${P.x}:${P.y},scale=10:1:flags=area,format=gray`, "-f", "rawvideo", "-"]);
        expect(raw.length).toBe(plan.frameCount * 10);
        let checked = 0;
        for (let k = 0; k < plan.frameCount; k++) {
          if (activeTransitionAt(tl, transitions.get(videoTrack), tlFrame(k))) continue;
          let n = 0;
          for (let b = 0; b < 10; b++) if (raw[k * 10 + b] > 128) n |= 1 << b;
          const local = Math.floor(((k + 0.5) * 30) / fps);
          const expected = tlFrame(k) < L.cut.frame ? local : L.cut.sourceJump[1] + local - L.cut.frame;
          expect(`k=${k} -> ${n}`).toBe(`k=${k} -> ${expected}`);
          checked++;
        }
        expect(checked).toBeGreaterThan(plan.frameCount * 0.8);
      });

      it.skipIf(P.x === 0 && P.y === 0 && P.width === W && P.height === H)("framing: letterbox bars are empty / fill crops at the planned offset", () => {
        const k = Math.round(fps * 0.5);
        const img = frameRgba(k);
        if (plan.settings.framing === "fit") {
          // Middle of each bar: black (opaque) or fully transparent (alpha).
          const bars = P.y > 0 ? [[W / 2, P.y / 2], [W / 2, P.y + P.height + (H - P.y - P.height) / 2]] : [[P.x / 2, H / 2], [P.x + P.width + (W - P.x - P.width) / 2, H / 2]];
          for (const [x, y] of bars) {
            const o = (Math.round(y) * W + Math.round(x)) * 4;
            if (plan.settings.alpha) expect(img[o + 3]).toBeLessThanOrEqual(4);
            else expect(Math.max(img[o], img[o + 1], img[o + 2])).toBeLessThanOrEqual(20);
          }
        }
        // The keyframed box lands where placement × keyframe value says (proves scale AND offset).
        const box = tl.clips[Object.keys(tl.clips).find((id) => tl.clips[id].trackId === tl.trackIds.find((t) => tl.tracks[t].name === "box"))!].animation!.tracks["visual.transform.x"];
        const wantX = P.x + evaluateTrack(box, tlFrame(k)) * s;
        const y = Math.round(P.y + L.box.y * s);
        let x0 = -1;
        let x1 = -1;
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          if (img[o + 2] > 180 && img[o] < 70 && img[o + 1] < 70) {
            if (x0 < 0) x0 = x;
            x1 = x;
          }
        }
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(Math.abs((x0 + x1) / 2 - wantX)).toBeLessThan(2.5);
        expect(x1 - x0 + 1).toBeGreaterThan(L.box.size * s - 4);
      });

      it.skipIf(!plan.settings.alpha)("alpha: empty areas transparent, 50 % logo half-transparent, shapes opaque", () => {
        for (const k of [0, Math.round(fps * 2), plan.frameCount - 1]) {
          const img = frameRgba(k);
          const [, , , aEmpty] = at(img, 0.05 * L.width, 0.97 * L.height);
          expect(aEmpty).toBeLessThanOrEqual(4);
          const [lr, lg, , la] = at(img, L.logo.x, L.logo.y);
          expect(Math.abs(la - 128)).toBeLessThan(20);
          expect(lr - lg).toBeGreaterThan(150);
          const [, mg, , ma] = at(img, L.mask.x, L.mask.y);
          expect(ma).toBeGreaterThanOrEqual(247);
          expect(mg).toBeGreaterThan(200);
          // Outside the ellipse mask the green rect is cut away: transparent there.
          expect(at(img, L.mask.x - L.mask.size * 0.47, L.mask.y - L.mask.size * 0.47)[3]).toBeLessThanOrEqual(4);
        }
      });
    });
  }
});
