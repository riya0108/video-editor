import { describe, expect, it } from "vitest";
import { SequentialFrameCursor } from "./sequential-frame-cursor";

type FakeFrame = { idx: number; timestamp: number; close(): void };

/** A fake decoder stream over frames at `fps`, starting (like Mediabunny) at the frame covering startSec. Tracks every decode and every close. */
function fakeSource(fps: number, count: number) {
  const decoded: number[] = [];
  const open = new Set<number>();
  const closedTwice: number[] = [];
  const openIter = (startSec: number): AsyncIterator<FakeFrame> => {
    let i = Math.max(0, Math.min(count - 1, Math.floor(startSec * fps + 1e-9)));
    return {
      async next() {
        if (i >= count) return { done: true as const, value: undefined };
        const idx = i++;
        decoded.push(idx);
        open.add(idx);
        let closed = false;
        return {
          done: false as const,
          value: {
            idx,
            timestamp: idx / fps,
            close() {
              if (closed) closedTwice.push(idx);
              closed = true;
              open.delete(idx);
            },
          },
        };
      },
      async return() {
        return { done: true as const, value: undefined };
      },
    };
  };
  return { openIter, decoded, open, closedTwice };
}

const mid = (n: number, fps: number) => (n + 0.5) / fps;

describe("SequentialFrameCursor", () => {
  it("returns the frame covering t (last start <= t), decoding sequential requests exactly once", async () => {
    const src = fakeSource(30, 100);
    const c = new SequentialFrameCursor(src.openIter);
    for (let n = 0; n < 60; n++) expect((await c.frameAt(mid(n, 30))).idx).toBe(n);
    expect(c.restarts).toBe(1);
    // Each frame decoded once, plus one look-ahead.
    expect(src.decoded).toEqual(Array.from({ length: 61 }, (_, i) => i));
    // Only the current frame and the look-ahead are held.
    expect(src.open.size).toBe(2);
    await c.close();
    expect(src.open.size).toBe(0);
    expect(src.closedTwice).toEqual([]);
  });

  it("repeats a frame without decoding (output rate above source rate)", async () => {
    const src = fakeSource(24, 50);
    const c = new SequentialFrameCursor(src.openIter);
    const got: number[] = [];
    for (let k = 0; k < 10; k++) got.push((await c.frameAt((k + 0.5) / 60)).idx);
    // Last frame starting at or before t: (k + 0.5) / 60 * 24 = 0.4k + 0.2.
    expect(got).toEqual([0, 0, 1, 1, 1, 2, 2, 3, 3, 3]);
    expect(c.restarts).toBe(1);
  });

  it("restarts on a backward jump and on a far forward jump, and is still exact", async () => {
    const src = fakeSource(30, 3000);
    const c = new SequentialFrameCursor(src.openIter, 2);
    expect((await c.frameAt(mid(10, 30))).idx).toBe(10);
    expect((await c.frameAt(mid(5, 30))).idx).toBe(5);
    expect(c.restarts).toBe(2);
    expect((await c.frameAt(mid(40, 30))).idx).toBe(40); // within 2 s: decode forward
    expect(c.restarts).toBe(2);
    expect((await c.frameAt(mid(1000, 30))).idx).toBe(1000); // far: restart, no decoding through 960 frames
    expect(c.restarts).toBe(3);
    expect(src.decoded.length).toBeLessThan(70);
    await c.close();
    expect(src.open.size).toBe(0);
  });

  it("random access picks the same frames as sequential access", async () => {
    const src = fakeSource(24, 72);
    const seq = new SequentialFrameCursor(src.openIter);
    const t = (n: number) => (n + 0.5 + 1e-4) / 30;
    const got: number[] = [];
    for (let n = 0; n < 30; n++) got.push((await seq.frameAt(t(n))).idx);
    expect(got).toEqual(Array.from({ length: 30 }, (_, n) => Math.floor(t(n) * 24)));
    expect(seq.restarts).toBe(1);
    for (const n of [17, 2, 12, 29, 7]) {
      const c = new SequentialFrameCursor(src.openIter);
      expect((await c.frameAt(t(n))).idx).toBe(got[n]);
    }
  });

  it("does not restart every request while t is before the first frame", async () => {
    const decoded: number[] = [];
    const open = (start: number): AsyncIterator<{ idx: number; timestamp: number; close(): void }> => {
      let i = 0;
      return { next: async () => (i < 5 ? (decoded.push(i), { done: false, value: { idx: i, timestamp: 0.1 + i++ / 30, close() {} } }) : { done: true, value: undefined }) };
    };
    const c = new SequentialFrameCursor(open);
    expect((await c.frameAt(0.01)).idx).toBe(0);
    expect((await c.frameAt(0.05)).idx).toBe(0);
    expect(c.restarts).toBe(1);
  });

  it("holds the last frame past the end of the stream", async () => {
    const src = fakeSource(30, 10);
    const c = new SequentialFrameCursor(src.openIter);
    expect((await c.frameAt(mid(8, 30))).idx).toBe(8);
    expect((await c.frameAt(mid(9, 30) + 0.01)).idx).toBe(9);
    expect((await c.frameAt(0.33)).idx).toBe(9);
  });

  it("holds the last frame of a finished stream without restarting (truncated file: header longer than its data)", async () => {
    const src = fakeSource(30, 10);
    const c = new SequentialFrameCursor(src.openIter, 2);
    for (let n = 0; n < 10; n++) await c.frameAt(mid(n, 30));
    const decodedBefore = src.decoded.length;
    for (let n = 10; n < 300; n++) expect((await c.frameAt(mid(n, 30))).idx).toBe(9);
    expect(c.restarts).toBe(1);
    expect(src.decoded.length).toBe(decodedBefore);
    // Going back still works.
    expect((await c.frameAt(mid(3, 30))).idx).toBe(3);
  });

  it("throws when nothing can be decoded", async () => {
    const c = new SequentialFrameCursor(() => ({ next: async () => ({ done: true as const, value: undefined }) }) as AsyncIterator<{ timestamp: number; close(): void }>);
    await expect(c.frameAt(0.5)).rejects.toThrow(/No video frame/);
  });
});
