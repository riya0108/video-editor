import { describe, it, expect } from "vitest";
import { supportsImage, supportsVideo, isTemporal } from "./types";
import { FakeMattingModel } from "./test-fakes";

describe("capability guard functions", () => {
  it("supportsImage requires both the declared capability and the implemented method", () => {
    const withBoth = new FakeMattingModel({ supportedMedia: ["image"] });
    expect(supportsImage(withBoth)).toBe(true);

    // Simulates a buggy adapter that declares "image" support but doesn't
    // actually implement inferImage — the guard must not trust the
    // capability alone.
    const declaredOnly = new FakeMattingModel({ supportedMedia: ["image"] });
    delete declaredOnly.inferImage;
    expect(supportsImage(declaredOnly)).toBe(false);
  });

  it("supportsVideo mirrors the same rule for video, independently of image support", () => {
    const videoOnly = new FakeMattingModel({ supportedMedia: ["video"] });
    expect(supportsVideo(videoOnly)).toBe(true);
    expect(supportsImage(videoOnly)).toBe(false);
  });

  it("a model can support both media kinds at once", () => {
    const both = new FakeMattingModel({ supportedMedia: ["image", "video"] });
    expect(supportsImage(both)).toBe(true);
    expect(supportsVideo(both)).toBe(true);
  });

  it("isTemporal requires both supportsTemporal and resetTemporalState", () => {
    const temporal = new FakeMattingModel({ supportedMedia: ["video"], supportsTemporal: true });
    expect(isTemporal(temporal)).toBe(true);

    const nonTemporal = new FakeMattingModel({ supportedMedia: ["video"], supportsTemporal: false });
    expect(isTemporal(nonTemporal)).toBe(false);

    // A per-frame model (supportsTemporal: false) is not temporal even
    // though it handles video — the two are deliberately different axes
    // (see types.ts's ModelClass/supportsTemporal doc comments).
    const declaredOnly = new FakeMattingModel({ supportedMedia: ["video"], supportsTemporal: true });
    delete declaredOnly.resetTemporalState;
    expect(isTemporal(declaredOnly)).toBe(false);
  });
});
