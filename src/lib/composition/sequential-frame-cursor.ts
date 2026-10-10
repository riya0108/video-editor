/**
 * SEQUENTIAL EXACT-FRAME CURSOR (PERFORMANCE_OPTIMIZATION_REPORT.md §2) — the final render's video decode policy.
 *
 * An export asks for frames in order. Seeking a <video> element per frame restarts decoding at the previous keyframe
 * every time (and two clips of one source fight over one element); a decoder iterator that only ever moves forward
 * decodes each frame once. This cursor sits on such an iterator (Mediabunny's VideoSampleSink.samples(), WebCodecs
 * hardware decode) and answers "the frame shown at time t" with the same rule a seeked <video> uses: the last frame
 * whose start timestamp is <= t (the first frame if t is before it). Callers never ask for a time exactly on a frame
 * boundary (media-frame-provider.ts sourceTimeSec), where decoders' sub-microsecond rounding would decide.
 *
 *  - t inside the current frame          -> the current frame, no decoding
 *  - t a little ahead (<= maxForwardSec) -> decode forward to it
 *  - t behind, or far ahead              -> restart the iterator at t (the decoder seeks to the keyframe itself)
 *
 * The returned frame is owned by the cursor and stays valid until the next frameAt()/close() call — callers copy it.
 * Pure policy over an injected iterator, so it is Node-tested with fake frames.
 */

export interface TimedFrame {
  timestamp: number;
  close(): void;
}

export class SequentialFrameCursor<F extends TimedFrame> {
  private iter: AsyncIterator<F> | null = null;
  private cur: F | null = null;
  /** undefined = not pulled yet; null = the stream ended. */
  private next: F | null | undefined = undefined;
  /** Earliest time the current frame answers for: its start, or the restart time when it's the stream's first frame and t was before it. */
  private coveredFrom = Infinity;
  /** Decoder (re)starts so far — a measure of how sequential the access pattern was. */
  restarts = 0;

  constructor(
    private readonly open: (startSec: number) => AsyncIterator<F>,
    private readonly maxForwardSec = 2,
  ) {}

  async frameAt(t: number): Promise<F> {
    // Past the end of a finished stream there is nothing newer to decode: hold the last frame. (A file whose header
    // claims more duration than its data holds asks for times past the end on every frame — restarting each time made
    // those exports ~6× slower, FULL_QA_REPORT.md.)
    const heldAtEnd = this.cur !== null && this.next === null && t >= this.cur.timestamp;
    if (!heldAtEnd && (!this.cur || t < this.coveredFrom || t > this.cur.timestamp + this.maxForwardSec)) await this.restart(t);
    for (;;) {
      if (this.next === undefined) this.next = await this.pull();
      if (!this.next || this.next.timestamp > t) break;
      this.cur!.close();
      this.cur = this.next;
      this.coveredFrom = this.cur.timestamp;
      this.next = undefined;
    }
    return this.cur!;
  }

  async close(): Promise<void> {
    this.cur?.close();
    this.next?.close();
    this.cur = null;
    this.next = undefined;
    this.coveredFrom = Infinity;
    const it = this.iter;
    this.iter = null;
    await it?.return?.();
  }

  private async restart(t: number) {
    await this.close();
    this.restarts++;
    // The iterator starts at the last frame starting at or before t (Mediabunny's samples(start) contract).
    this.iter = this.open(t);
    const first = await this.pull();
    if (!first) throw new Error(`No video frame at or after ${t.toFixed(3)} s.`);
    this.cur = first;
    this.coveredFrom = Math.min(first.timestamp, t);
  }

  private async pull(): Promise<F | null> {
    const r = await this.iter!.next();
    return r.done ? null : r.value;
  }
}
