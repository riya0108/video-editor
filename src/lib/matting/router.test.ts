import { describe, it, expect } from "vitest";
import { selectModel, rankModels } from "./router";
import { FakeMattingModel } from "./test-fakes";

function portraitMatting() {
  return new FakeMattingModel({
    modelId: "fake-portrait-matting",
    modelClass: "matting",
    supportedMedia: ["image"],
    supportedSubjects: ["portrait"],
  });
}

function generalSegmentation() {
  return new FakeMattingModel({
    modelId: "fake-general-segmentation",
    modelClass: "segmentation",
    supportedMedia: ["image"],
    supportedSubjects: ["general"],
  });
}

function generalMatting() {
  return new FakeMattingModel({
    modelId: "fake-general-matting",
    modelClass: "matting",
    supportedMedia: ["image"],
    supportedSubjects: ["general"],
  });
}

function temporalVideoMatting() {
  return new FakeMattingModel({
    modelId: "fake-temporal-video",
    modelClass: "matting",
    supportedMedia: ["video"],
    supportedSubjects: ["portrait"],
    supportsTemporal: true,
  });
}

function perFrameVideoSegmentation() {
  return new FakeMattingModel({
    modelId: "fake-per-frame-video",
    modelClass: "segmentation",
    supportedMedia: ["video"],
    supportedSubjects: ["portrait"],
    supportsTemporal: false,
  });
}

function knownBackgroundMatting() {
  return new FakeMattingModel({
    modelId: "fake-known-bg",
    modelClass: "matting",
    supportedMedia: ["image"],
    supportedSubjects: ["known-background"],
    requiredInputs: ["frame", "background-plate"],
  });
}

function copyleftBlocked() {
  return new FakeMattingModel({
    modelId: "fake-copyleft",
    modelClass: "matting",
    supportedMedia: ["video"],
    supportedSubjects: ["portrait"],
    supportsTemporal: true,
    license: { id: "GPL-3.0", commercialUse: false, redistributable: false, copyleft: true, sourceUrl: "https://example.test" },
  });
}

function nonCommercialGeneral() {
  return new FakeMattingModel({
    modelId: "fake-non-commercial",
    modelClass: "segmentation",
    supportedMedia: ["image"],
    supportedSubjects: ["general", "portrait", "product"],
    license: { id: "non-commercial", commercialUse: false, redistributable: false, sourceUrl: "https://example.test" },
  });
}

describe("selectModel — the routing rules from the architecture brief", () => {
  it("human image -> portrait matting model, over a general segmentation model", () => {
    const routed = selectModel([generalSegmentation(), portraitMatting()], { media: "image", subject: "portrait" });
    expect(routed?.model.capabilities.modelId).toBe("fake-portrait-matting");
    expect(routed?.requiresRefinement).toBe(false); // it's matting-class, not segmentation
  });

  it("human video -> temporal video matting model, over a per-frame segmentation model", () => {
    const routed = selectModel([perFrameVideoSegmentation(), temporalVideoMatting()], {
      media: "video",
      subject: "portrait",
    });
    expect(routed?.model.capabilities.modelId).toBe("fake-temporal-video");
  });

  it("degrades gracefully to per-frame segmentation for video when the temporal candidate is license-blocked", () => {
    const routed = selectModel([perFrameVideoSegmentation(), copyleftBlocked()], {
      media: "video",
      subject: "portrait",
    });
    expect(routed?.model.capabilities.modelId).toBe("fake-per-frame-video");
  });

  it("general object image -> segmentation model, explicitly flagged as needing refinement (never silently treated as a finished matte)", () => {
    const routed = selectModel([generalSegmentation()], { media: "image", subject: "general" });
    expect(routed?.model.capabilities.modelId).toBe("fake-general-segmentation");
    expect(routed?.requiresRefinement).toBe(true);
  });

  it("prefers a general-purpose matting model over a segmentation model for the same subject, when both are eligible — 'U²-Net isn't automatically high-quality' means a real matting model outranks it, not that it's excluded", () => {
    const routed = selectModel([generalSegmentation(), generalMatting()], { media: "image", subject: "general" });
    expect(routed?.model.capabilities.modelId).toBe("fake-general-matting");
    expect(routed?.requiresRefinement).toBe(false);
  });

  it("known static background -> background-matting-capable model, but ONLY when a background plate is actually available", () => {
    const models = [generalSegmentation(), knownBackgroundMatting()];
    const withoutPlate = selectModel(models, { media: "image", subject: "known-background" });
    expect(withoutPlate?.model.capabilities.modelId).not.toBe("fake-known-bg");

    const withPlate = selectModel(models, { media: "image", subject: "known-background", hasBackgroundPlate: true });
    expect(withPlate?.model.capabilities.modelId).toBe("fake-known-bg");
  });

  it("never routes an image request to a video-only model — 'do not use RVM for every image'", () => {
    const routed = selectModel([temporalVideoMatting()], { media: "image", subject: "portrait" });
    expect(routed).toBeNull();
  });

  it("excludes a non-commercial-licensed model by default, and only includes it when the caller explicitly opts in", () => {
    const models = [nonCommercialGeneral()];
    expect(selectModel(models, { media: "image", subject: "general" })).toBeNull();

    const routed = selectModel(models, { media: "image", subject: "general", allowNonCommercial: true });
    expect(routed?.model.capabilities.modelId).toBe("fake-non-commercial");
  });

  it("never selects a copyleft-licensed model, even with allowNonCommercial set — that escape hatch is for a purchasable commercial license, not copyleft", () => {
    const models = [copyleftBlocked()];
    expect(selectModel(models, { media: "video", subject: "portrait" })).toBeNull();
    expect(selectModel(models, { media: "video", subject: "portrait", allowNonCommercial: true })).toBeNull();
  });

  it("returns null when no model is eligible", () => {
    expect(selectModel([], { media: "image", subject: "portrait" })).toBeNull();
  });

  it("degrades honestly for an 'unknown' subject (no real subject detector exists yet): still prefers matting over segmentation, still eligible via the 'general' fallback bonus", () => {
    const routed = selectModel([generalSegmentation(), generalMatting()], { media: "image", subject: "unknown" });
    expect(routed?.model.capabilities.modelId).toBe("fake-general-matting");
  });

  it("an 'unknown' subject never gets the exact-match bonus, even against a model whose only supported subject happens to be named the same as a real SubjectKind", () => {
    // Sanity check that "unknown" truly never matches — portraitMatting only
    // declares supportedSubjects:["portrait"], not "general", so with an
    // unknown subject it scores the same baseline as any other non-general,
    // non-matching model would (0 subject bonus), while still beating
    // nothing via its matting-class bonus.
    const routed = selectModel([portraitMatting()], { media: "image", subject: "unknown" });
    expect(routed?.model.capabilities.modelId).toBe("fake-portrait-matting");
    expect(routed?.score).toBe(5); // matting bonus only, no subject-match or general-fallback bonus
  });
});

describe("rankModels", () => {
  it("ranks every eligible model best-first and omits ineligible ones", () => {
    const ranked = rankModels([generalSegmentation(), portraitMatting(), temporalVideoMatting()], {
      media: "image",
      subject: "portrait",
    });
    expect(ranked.map((r) => r.model.capabilities.modelId)).toEqual([
      "fake-portrait-matting",
      "fake-general-segmentation",
    ]);
  });

  it("returns an empty array, not null, when nothing is eligible", () => {
    expect(rankModels([], { media: "image", subject: "portrait" })).toEqual([]);
  });
});
