import { describe, it, expect } from "vitest";
import { ModelRouter, type RoutingRequest, type DeviceCapability } from "./model-router";
import { createModelRegistry } from "./models/registry";
import { ModNetAdapter } from "./models/modnet";
import { BackgroundMattingV2Adapter } from "./models/background-matting-v2";
import { FakeMattingModel } from "./test-fakes";
import { createCollectingLogger } from "./pipeline/logger";
import type { MattingModel } from "./types";

// PRODUCTION READINESS (H1): modnet/background-matting-v2 were removed from
// createModelRegistry() (their weight files were never bundled — see
// registry.ts's own doc comment). This router's tests are about its SCORING
// LOGIC against the full hypothetical candidate universe the brief
// describes (portrait -> matting model, known-background -> BGMv2, etc.),
// independent of which adapters are safe to expose in the live production
// registry today — so tests here use this fuller list rather than the
// production-scoped one.
function createModelRegistry_full(): MattingModel[] {
  return [...createModelRegistry(), new ModNetAdapter(), new BackgroundMattingV2Adapter()];
}

function device(tier: DeviceCapability["tier"], webgpuAvailable = true): DeviceCapability {
  return { tier, webgpuAvailable };
}

function baseRequest(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    media: "image",
    width: 1024,
    height: 1024,
    subjectHint: "unknown",
    subjectCount: 1,
    backgroundComplexity: "simple",
    hasBackgroundPlate: false,
    transparencyIndicators: false,
    motion: "none",
    hairDetailIndicators: false,
    device: device("mid-range"),
    ...overrides,
  };
}

describe("ModelRouter — example routing rules from the brief", () => {
  it("HUMAN IMAGE -> portrait matting model", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait", media: "image" }));
    expect(decision.selected?.model.capabilities.modelId).toBe("modnet");
    expect(decision.selected?.model.capabilities.modelClass).toBe("matting");
  });

  it("HUMAN VIDEO with the real (licensed) model set falls back to the best ELIGIBLE candidate, never the license-blocked temporal model", () => {
    // Honest limitation, not a gap in the router: RobustVideoMatting (rvm.ts)
    // is the only temporal *matting*-class video model this app declares,
    // and it's GPL-3.0 — router.ts's eligibility check excludes it
    // unconditionally (no allowNonCommercial escape hatch for copyleft).
    // The correct behavior is falling back to the best model that's
    // actually usable, not silently pretending RVM was selected.
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait", media: "video" }));
    expect(decision.selected?.model.capabilities.modelId).toBe("mediapipe-selfie-segmenter");
    expect(decision.selected?.requiresRefinement).toBe(true);
  });

  it("HUMAN VIDEO prefers a temporal matting model over a per-frame segmenter when one is actually eligible", () => {
    // Demonstrates the temporal-preference routing logic itself (router.ts's
    // existing +8 supportsTemporal bonus on video, reused here), independent
    // of this app's specific real model set's licensing situation above.
    const fakeTemporalMatting = new FakeMattingModel({
      modelId: "fake-temporal-matting",
      modelClass: "matting",
      supportedMedia: ["video"],
      supportedSubjects: ["portrait"],
      supportsTemporal: true,
      deviceSupport: ["webgpu", "wasm"],
      license: { id: "MIT", commercialUse: true, redistributable: true, sourceUrl: "https://example.test" },
    });
    const models: MattingModel[] = [...createModelRegistry_full(), fakeTemporalMatting];

    const router = new ModelRouter();
    const decision = router.route(models, baseRequest({ subjectHint: "portrait", media: "video" }));
    expect(decision.selected?.model.capabilities.modelId).toBe("fake-temporal-matting");
  });

  it("GENERAL OBJECT -> a commercial-safe segmentation model, with refinement recommended", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "general", media: "image" }));
    expect(decision.selected?.model.capabilities.modelId).toBe("u2net");
    expect(decision.selected?.model.capabilities.modelClass).toBe("segmentation");
    expect(decision.selected?.requiresRefinement).toBe(true);
    expect(decision.refinementStrategy.runAlphaRefinement).toBe(true);
  });

  it("STATIC BACKGROUND AVAILABLE -> background matting model", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "known-background", hasBackgroundPlate: true }));
    expect(decision.selected?.model.capabilities.modelId).toBe("background-matting-v2");
  });

  it("DIFFICULT CASE -> the stronger model plus a fuller refinement pipeline, even though it costs more", () => {
    const router = new ModelRouter();
    const difficult = baseRequest({
      subjectHint: "portrait",
      hairDetailIndicators: true,
      backgroundComplexity: "complex",
      transparencyIndicators: true,
      motion: "low",
      device: device("mid-range"),
    });
    const decision = router.route(createModelRegistry_full(), difficult);

    expect(decision.difficultyScore).toBeGreaterThan(0.5);
    expect(decision.selected?.model.capabilities.modelId).toBe("modnet");
    expect(decision.refinementStrategy.intensity).toBe("aggressive");
    expect(decision.refinementStrategy.runHairRefinement).toBe(true);
    expect(decision.refinementStrategy.runColourDecontamination).toBe(true);
  });

  it("LOW-END DEVICE -> the lighter, optimized model instead of the heavier matting model", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait", device: device("low-end") }));
    expect(decision.selected?.model.capabilities.modelId).toBe("mediapipe-selfie-segmenter");
  });

  it("HIGH-END GPU -> the higher-quality matting model", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait", device: device("high-end") }));
    expect(decision.selected?.model.capabilities.modelId).toBe("modnet");
  });

  it("does not automatically use the largest/heaviest model — the same subject request resolves differently by device tier", () => {
    const router = new ModelRouter();
    const request = (tier: DeviceCapability["tier"]) => baseRequest({ subjectHint: "portrait", device: device(tier) });
    const lowEnd = router.route(createModelRegistry_full(), request("low-end")).selected?.model.capabilities.modelId;
    const highEnd = router.route(createModelRegistry_full(), request("high-end")).selected?.model.capabilities.modelId;
    expect(lowEnd).not.toBe(highEnd);
  });
});

describe("ModelRouter — balancing quality/latency/memory/resolution/subject type", () => {
  it("a tight latency constraint shifts the choice toward the lighter model even on capable hardware", () => {
    const router = new ModelRouter();
    const relaxed = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait", device: device("high-end") }));
    const constrained = router.route(
      createModelRegistry_full(),
      baseRequest({ subjectHint: "portrait", device: device("high-end"), performanceConstraints: { maxLatencyMs: 50 } }),
    );
    expect(relaxed.selected?.model.capabilities.modelId).toBe("modnet");
    expect(constrained.selected?.model.capabilities.modelId).toBe("mediapipe-selfie-segmenter");
  });

  it("resolution: a request above the selected model's max resolution is clamped and flagged for tiling", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "known-background", hasBackgroundPlate: true, width: 6000, height: 6000 }));
    expect(decision.processingStrategy?.recommendTiling).toBe(true);
    expect(decision.processingStrategy!.targetWidth).toBeLessThanOrEqual(4096); // background-matting-v2's declared maxWidth
  });

  it("subject type: an unknown subject still routes to a commercially-safe general-purpose model rather than failing", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "unknown" }));
    expect(decision.selected).not.toBeNull();
    expect(decision.selected?.model.capabilities.license.commercialUse).toBe(true);
  });
});

describe("ModelRouter — fallback strategy", () => {
  it("lists the remaining eligible candidates, best-first, for use if the primary selection fails or scores poorly", () => {
    const router = new ModelRouter();
    const decision = router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait" }));
    expect(decision.fallbackStrategy.alternativeModels.length).toBeGreaterThan(0);
    expect(decision.fallbackStrategy.alternativeModels[0].model.capabilities.modelId).not.toBe(decision.selected?.model.capabilities.modelId);
    expect(decision.fallbackStrategy.triggerOn).toContain("low-quality");
  });

  it("reports no selection, a null processing strategy, and an empty fallback list when nothing is eligible", () => {
    const router = new ModelRouter();
    // Only a background-plate-requiring model, with no plate supplied.
    const models = createModelRegistry_full().filter((m) => m.capabilities.modelId === "background-matting-v2");
    const decision = router.route(models, baseRequest({ subjectHint: "known-background", hasBackgroundPlate: false }));

    expect(decision.selected).toBeNull();
    expect(decision.processingStrategy).toBeNull();
    expect(decision.fallbackStrategy.alternativeModels).toHaveLength(0);
  });
});

describe("ModelRouter — logs every routing decision", () => {
  it("emits exactly one info-level entry describing a successful decision", () => {
    const { logger, entries } = createCollectingLogger();
    const router = new ModelRouter(logger);
    router.route(createModelRegistry_full(), baseRequest({ subjectHint: "portrait" }));

    const infoEntries = entries.filter((e) => e.level === "info" && e.stage === "model-router");
    expect(infoEntries).toHaveLength(1);
    expect(infoEntries[0].data?.selectedModelId).toBe("modnet");
  });

  it("still logs (at warn level) when no model is eligible", () => {
    const { logger, entries } = createCollectingLogger();
    const router = new ModelRouter(logger);
    const models = createModelRegistry_full().filter((m) => m.capabilities.modelId === "background-matting-v2");
    router.route(models, baseRequest({ subjectHint: "known-background", hasBackgroundPlate: false }));

    expect(entries.some((e) => e.level === "warn" && e.stage === "model-router")).toBe(true);
  });
});
