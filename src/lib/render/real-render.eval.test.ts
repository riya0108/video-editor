import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { TimelineModel } from "../timeline/model";
import { evaluateTrack } from "../animation/keyframes";
import { activeTransitionAt, transitionsByTrack } from "../transitions/model";
import type { ProbeLayout } from "./probe-project";

/**
 * REAL RENDER EVALUATION (RENDER_ENGINE_TEST_REPORT.md). Every MP4 the browser rendered from the probe project
 * (`.tmp-test-assets/phase15/r-*.mp4` + `.meta.json`, git-ignored — the suite skips where they don't exist) is checked
 * with an INDEPENDENT decoder, ffmpeg, against expectations computed from the rendered timeline itself:
 *   format (size, frame count, fps, duration, audio format and exact sample count), the SOURCE frame shown by every
 *   output frame (binary counter), keyframed position + layer order, effect, mask, alpha, text, caption timing,
 *   cross-dissolve mixing, and audio beep timing (A/V sync).
 */
const DIR = join(process.cwd(), ".tmp-test-assets", "phase15");
const renders = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^r-.*\.meta\.json$/.test(f)).map((f) => f.replace(/\.meta\.json$/, "")) : [];

interface Meta {
  plan: { frameCount: number; durationSec: number; audioSamples: number; projectFps: number; renderScale: number; settings: { width: number; height: number; fps: number; audio: { sampleRate: number } | null } };
  layout: ProbeLayout;
  timeline: TimelineModel;
}

const ff = (args: string[], maxBuffer = 1 << 30) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { maxBuffer });
const probe = (file: string, entries: string, stream: "v" | "a") =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", stream, "-show_entries", entries, "-of", "json", file]).toString()).streams[0];

/** RGB24 of output frame k at full output size. */
function frameRgb(file: string, k: number, w: number, h: number): Uint8Array {
  const buf = ff(["-i", file, "-vf", `select=eq(n\\,${k})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  expect(buf.length).toBe(w * h * 3);
  return buf;
}

describe.skipIf(renders.length === 0)("real renders, decoded by ffmpeg", () => {
  for (const name of renders) {
    describe(name, () => {
      const file = join(DIR, `${name}.mp4`);
      const meta = JSON.parse(readFileSync(join(DIR, `${name}.meta.json`), "utf8")) as Meta;
      const { plan, layout: L, timeline: tl } = meta;
      const { width: W, height: H, fps } = plan.settings;
      const s = plan.renderScale;
      const tlFrame = (k: number) => (k * plan.projectFps) / fps;
      const transitions = transitionsByTrack(tl);
      const videoTrack = tl.trackIds.find((id) => tl.tracks[id].name === "video")!;
      const inTransition = (k: number) => !!activeTransitionAt(tl, transitions.get(videoTrack), tlFrame(k));
      const px = (rgb: Uint8Array, x: number, y: number) => {
        const o = (Math.round(y) * W + Math.round(x)) * 3;
        return [rgb[o], rgb[o + 1], rgb[o + 2]];
      };

      it("format: size, exact frame count, fps, duration; audio 48 kHz stereo, exact sample count", () => {
        const v = probe(file, "stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration", "v");
        expect([v.width, v.height]).toEqual([W, H]);
        expect(Number(v.nb_read_frames)).toBe(plan.frameCount);
        expect(v.r_frame_rate).toBe(`${fps}/1`);
        expect(Number(v.duration)).toBeCloseTo(plan.durationSec, 3);
        expect(v.codec_name).toBe("h264");
        const a = probe(file, "stream=codec_name,sample_rate,channels,duration", "a");
        expect([a.codec_name, Number(a.sample_rate), a.channels]).toEqual(["aac", 48000, 2]);
        const pcm = ff(["-i", file, "-map", "0:a", "-ac", "1", "-f", "f32le", "-"]);
        expect(pcm.length / 4).toBe(plan.audioSamples);
      });

      it("every output frame shows the right SOURCE frame (counter), outside the dissolve", () => {
        const rows = Math.floor(L.counterRows * s * 0.9);
        const raw = ff(["-i", file, "-vf", `crop=${W}:${rows}:0:0,scale=10:1:flags=area,format=gray`, "-f", "rawvideo", "-"]);
        expect(raw.length).toBe(plan.frameCount * 10);
        let checked = 0;
        for (let k = 0; k < plan.frameCount; k++) {
          if (inTransition(k)) continue;
          let n = 0;
          for (let b = 0; b < 10; b++) if (raw[k * 10 + b] > 128) n |= 1 << b;
          const f = tlFrame(k);
          // Media at the centre of the output frame: native source frame floor(t_centre x 30) (+ the B clip's in-point jump).
          const local = Math.floor(((k + 0.5) * 30) / fps);
          const expected = f < L.cut.frame ? local : L.cut.sourceJump[1] + local - L.cut.frame;
          expect(`k=${k} -> ${n}`).toBe(`k=${k} -> ${expected}`);
          checked++;
        }
        expect(checked).toBeGreaterThan(plan.frameCount * 0.8);
      });

      it("cross-dissolve: the window's middle frame mixes both clips' blocks", () => {
        const ks = Array.from({ length: plan.frameCount }, (_, k) => k).filter(inTransition);
        expect(ks.length).toBeGreaterThan(0);
        const k = ks[Math.floor(ks.length / 2)];
        const rgb = frameRgb(file, k, W, H);
        const local = Math.floor(((k + 0.5) * 30) / fps);
        const a = local; // outgoing clip continues past its out point (handles exist in the source)
        const b = L.cut.sourceJump[1] + local - L.cut.frame;
        const p = activeTransitionAt(tl, transitions.get(videoTrack), tlFrame(k))!.progress;
        for (let bit = 0; bit < 10; bit++) {
          const want = 16 + 219 * ((((a >> bit) & 1) * (1 - p)) + (((b >> bit) & 1) * p));
          const [r] = px(rgb, (bit + 0.5) * (W / 10), (L.counterRows * s) / 2);
          expect(Math.abs(r - want)).toBeLessThan(18);
        }
      });

      it("keyframed position, layer order, effect, mask, alpha, text — pixel probes", () => {
        const track = tl.clips[Object.keys(tl.clips).find((id) => tl.clips[id].trackId === tl.trackIds.find((t) => tl.tracks[t].name === "box"))!].animation!.tracks["visual.transform.x"];
        const u = L.u * s;
        for (const k of [0, Math.round(fps * 0.5), Math.round(fps * 1.5), Math.round(fps * 2.5), plan.frameCount - 1]) {
          const rgb = frameRgb(file, k, W, H);
          // Box: blue run along its centre row; centre within 2 px of the keyframe value at THIS output frame.
          const y = L.box.y * s;
          let x0 = -1;
          let x1 = -1;
          for (let x = 0; x < W; x++) {
            const [r, g, b] = px(rgb, x, y);
            if (b > 180 && r < 70 && g < 70) {
              if (x0 < 0) x0 = x;
              x1 = x;
            }
          }
          const wantX = evaluateTrack(track, tlFrame(k)) * s;
          expect(Math.abs((x0 + x1) / 2 - wantX)).toBeLessThan(2);
          expect(x1 - x0 + 1).toBeGreaterThan(L.box.size * s - 3);
          // Effect: the yellow rect's top strip (above the box) is GRAY (saturation -1).
          const [er, eg, eb] = px(rgb, L.fx.x * s + L.fx.w * s * 0.4, L.fx.y * s - L.fx.h * s * 0.45);
          expect(Math.max(er, eg, eb) - Math.min(er, eg, eb)).toBeLessThan(14);
          expect(eg).toBeGreaterThan(215);
          // Mask: centre green, corner (outside the ellipse) shows what's beneath.
          const [mr, mg, mb] = px(rgb, L.mask.x * s, L.mask.y * s);
          expect(mg > 200 && mr < 60 && mb < 60).toBe(true);
          const [cr, cg] = px(rgb, (L.mask.x - L.mask.size * 0.47) * s, (L.mask.y - L.mask.size * 0.47) * s);
          expect(cg - cr).toBeLessThan(40);
          // Alpha: 50% red over the gray video -> red channel ~ +127 over green, green ~ blue.
          const [ar, ag, ab] = px(rgb, L.logo.x * s, L.logo.y * s);
          expect(Math.abs(ar - ag - 127)).toBeLessThan(22);
          expect(Math.abs(ag - ab)).toBeLessThan(10);
          // Text: white glyph pixels in the title band, none of them red/green/blue tinted.
          let white = 0;
          for (let yy = L.title.y * s - 30 * u; yy < L.title.y * s + 30 * u; yy += 2) for (let xx = W / 2 - 220 * u; xx < W / 2 + 220 * u; xx += 2) {
            const [r, g, b] = px(rgb, xx, yy);
            if (r > 220 && g > 220 && b > 220) white++;
          }
          expect(white).toBeGreaterThan(400 * L.u * L.u * s * s);
        }
        // Layer order: when the box is over the yellow rect, the overlap is BLUE (box track is in front).
        const kOver = Array.from({ length: plan.frameCount }, (_, k) => k).find((k) => Math.abs(evaluateTrack(track, tlFrame(k)) - L.fx.x) < 20)!;
        const [r, g, b] = px(frameRgb(file, kOver, W, H), L.fx.x * s, L.fx.y * s);
        expect(b > 180 && r < 70 && g < 70).toBe(true);
      });

      it("caption: on screen exactly during its span", () => {
        const u = L.u * s;
        const whiteIn = (k: number) => {
          const rgb = frameRgb(file, k, W, H);
          let n = 0;
          for (let yy = 0.78 * H; yy < 0.9 * H; yy += 2) for (let xx = W / 2 - 250 * u; xx < W / 2 + 250 * u; xx += 2) {
            const [r, g, b] = px(rgb, xx, yy);
            if (r > 220 && g > 220 && b > 220) n++;
          }
          return n;
        };
        const first = Math.ceil((L.caption.startFrame * fps) / plan.projectFps - 1e-9);
        const last = Math.ceil((L.caption.endFrame * fps) / plan.projectFps - 1e-9) - 1;
        expect(whiteIn(first - 1)).toBe(0);
        expect(whiteIn(first)).toBeGreaterThan(200 * L.u * L.u * s * s);
        expect(whiteIn(last)).toBeGreaterThan(200 * L.u * L.u * s * s);
        expect(whiteIn(last + 1)).toBe(0);
      });

      it("audio: beeps exactly where the timeline puts them (A/V sync within 1 ms)", () => {
        const pcm = ff(["-i", file, "-map", "0:a", "-ac", "1", "-f", "f32le", "-"]);
        const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
        const onsets: number[] = [];
        let on = false;
        for (let i = 0; i < x.length; i += 8) {
          let e = 0;
          for (let j = i; j < Math.min(x.length, i + 8); j++) e = Math.max(e, Math.abs(x[j]));
          if (e > 0.1 && !on) onsets.push(i / 48000);
          on = e > 0.1;
        }
        expect(onsets.length).toBe(L.audio.beepsSec.length);
        onsets.forEach((t, i) => expect(Math.abs(t - L.audio.beepsSec[i])).toBeLessThan(0.001));
      });
    });
  }
});
