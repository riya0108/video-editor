import type { TimelineModel } from "../timeline/model";
import { audioSegments, isStaticGain, sampleEnvelope, clipGainAt } from "./engine-core";

/**
 * LIVE PLAYBACK (AUDIO_ENGINE_ARCHITECTURE.md §4). Schedules every audible
 * segment from audioSegments() on a Web Audio graph:
 *
 *   AudioBufferSourceNode (offset into the source = sync) -> GainNode (gain
 *   envelope: volume automation x gain x normalization x fades, the SAME
 *   curve the exporter uses) -> master -> destination
 *
 * The AudioContext clock is the MASTER CLOCK while playing: the timeline frame
 * shown is derived from it (minus output latency), so picture follows sound
 * and a slow render frame never makes them drift. Any edit while playing
 * re-schedules from the current position.
 */

/** Builds the graph for `timeline` starting at timeline time `fromSec`, with timeline `fromSec` landing at context time `when`. Shared by live playback and the OfflineAudioContext parity test. */
export function scheduleTimeline(ctx: BaseAudioContext, destination: AudioNode, timeline: TimelineModel, buffers: (sourceId: string) => AudioBuffer | undefined, fromSec: number, when: number): AudioScheduledSourceNode[] {
  const nodes: AudioScheduledSourceNode[] = [];
  for (const seg of audioSegments(timeline, { fromSec, hasAudio: (id) => !!buffers(id) })) {
    const buffer = buffers(seg.sourceId)!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    const at = when + (seg.timelineStartSec - fromSec);
    if (isStaticGain(seg.clip)) {
      gain.gain.value = clipGainAt(seg.clip, 0, timeline.composition);
    } else {
      const curve = sampleEnvelope(seg.clip, timeline.frameRate, seg.clipLocalStartSec, seg.clipLocalStartSec + seg.durationSec, timeline.composition);
      gain.gain.value = curve[0];
      gain.gain.setValueCurveAtTime(curve, at, seg.durationSec);
    }
    src.connect(gain).connect(destination);
    if (seg.sourceOffsetSec < buffer.duration) {
      src.start(at, seg.sourceOffsetSec, Math.min(seg.durationSec, buffer.duration - seg.sourceOffsetSec));
      nodes.push(src);
    }
  }
  return nodes;
}

const SCHEDULE_LEAD_SEC = 0.05;

export class AudioPlaybackEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private startCtxTime = 0;
  private startSec = 0;
  private fps = 30;
  private _playing = false;
  private continuous = false;

  constructor(private readonly buffers: (sourceId: string) => AudioBuffer | undefined) {}

  get playing(): boolean {
    return this._playing;
  }

  /** True when the audio clock is actually advancing. A context the browser hasn't allowed to start (autoplay policy) stays suspended — callers must not slave the picture to a frozen clock. */
  get clockRunning(): boolean {
    return this._playing && this.ctx?.state === "running";
  }

  /** Must be called from a user gesture the first time (browser autoplay policy). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Starts (or restarts) playback at `frame`. */
  play(timeline: TimelineModel, frame: number): void {
    this.start(timeline, frame / timeline.frameRate, false);
  }

  /**
   * Re-schedules after an edit (volume, mute, trim, move...) WITHOUT a hitch: the new graph starts where the old
   * clock will be once it's audible (scheduling lead + output latency ahead), and the clock is not clamped meanwhile —
   * so the playhead keeps moving continuously through the edit.
   */
  update(timeline: TimelineModel): void {
    if (!this._playing || !this.ctx) return;
    const ahead = SCHEDULE_LEAD_SEC + this.latency();
    this.start(timeline, this.currentFrameExact() / this.fps + ahead, true);
  }

  private start(timeline: TimelineModel, fromSec: number, continuous: boolean) {
    const ctx = this.ensureContext();
    this.stopNodes();
    this.fps = timeline.frameRate;
    this.startSec = Math.max(0, fromSec);
    this.continuous = continuous;
    // A small lead so the first buffers are scheduled before they're due.
    this.startCtxTime = ctx.currentTime + SCHEDULE_LEAD_SEC;
    this.nodes = scheduleTimeline(ctx, this.master!, timeline, this.buffers, this.startSec, this.startCtxTime);
    this._playing = true;
  }

  stop(): void {
    this.stopNodes();
    this._playing = false;
  }

  private latency(): number {
    if (!this.ctx) return 0;
    return (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? this.ctx.baseLatency ?? 0;
  }

  /** Timeline position the listener is hearing right now (fractional frames). */
  currentFrameExact(): number {
    if (!this.ctx || !this._playing) return this.startSec * this.fps;
    const elapsed = this.ctx.currentTime - this.startCtxTime - this.latency();
    // From a standstill, hold the first frame until sound actually starts; after an edit, keep the clock continuous.
    return (this.startSec + (this.continuous ? elapsed : Math.max(0, elapsed))) * this.fps;
  }

  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = v;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private stopNodes() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* never started / already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
  }
}
