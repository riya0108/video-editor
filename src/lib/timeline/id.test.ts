import { describe, it, expect, beforeEach } from "vitest";
import { createId, resetIdCountersForTests } from "./id";

beforeEach(() => {
  resetIdCountersForTests();
});

describe("createId", () => {
  it("produces deterministic, incrementing ids per prefix", () => {
    expect(createId("clip")).toBe("clip-1");
    expect(createId("clip")).toBe("clip-2");
  });

  it("keeps separate counters per prefix", () => {
    expect(createId("track")).toBe("track-1");
    expect(createId("clip")).toBe("clip-1");
    expect(createId("track")).toBe("track-2");
  });

  it("resetIdCountersForTests resets every prefix back to 0", () => {
    createId("clip");
    createId("clip");
    resetIdCountersForTests();
    expect(createId("clip")).toBe("clip-1");
  });
});
