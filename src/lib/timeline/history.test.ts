import { describe, it, expect } from "vitest";
import { createHistory, pushHistory, undo, redo, canUndo, canRedo } from "./history";

describe("createHistory", () => {
  it("starts with no past/future and the given present", () => {
    const h = createHistory(1);
    expect(h.present).toBe(1);
    expect(h.past).toEqual([]);
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

describe("pushHistory", () => {
  it("moves the old present into past and sets the new present", () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    expect(h.present).toBe(2);
    expect(h.past).toEqual([1]);
  });

  it("clears future (a new edit invalidates whatever redo would have replayed)", () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = pushHistory(h, 3);
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(3);
  });

  it("caps past at maxDepth, dropping the oldest entries", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 5; i++) h = pushHistory(h, i, 3);
    expect(h.past.length).toBe(3);
    expect(h.past).toEqual([2, 3, 4]);
    expect(h.present).toBe(5);
  });
});

describe("undo / redo", () => {
  it("undo restores the previous present and pushes current onto future", () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    expect(h.past).toEqual([1]);
    expect(h.future).toEqual([3]);
  });

  it("redo replays future back onto present", () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    h = undo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(h.future).toEqual([]);
  });

  it("undo/redo are no-ops at the boundaries rather than throwing", () => {
    const h = createHistory(1);
    expect(undo(h)).toEqual(h);
    const h2 = pushHistory(createHistory(1), 2);
    expect(redo(h2)).toEqual(h2); // nothing to redo yet
  });

  it("a full undo-everything, redo-everything round trip restores the exact same sequence", () => {
    let h = createHistory("a");
    h = pushHistory(h, "b");
    h = pushHistory(h, "c");
    h = undo(h);
    h = undo(h);
    expect(h.present).toBe("a");
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe("c");
  });
});
