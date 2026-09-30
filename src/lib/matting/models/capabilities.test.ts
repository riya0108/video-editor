import { describe, it, expect } from "vitest";
import { createModelRegistry } from "./registry";
import { ModNetAdapter } from "./modnet";
import { BackgroundMattingV2Adapter } from "./background-matting-v2";

// These tests only ever read each adapter's static `capabilities` object (or
// call load()/healthCheck() on the license-blocked RVM adapter, which never
// touches the network — see rvm.ts). No real model is downloaded or run:
// that's deliberately out of scope for this phase (MATTE_IMPLEMENTATION_PLAN.md
// section 18) and would require a browser/GPU environment Vitest's Node
// runner doesn't have.
//
// PRODUCTION READINESS (H1): ModNetAdapter/BackgroundMattingV2Adapter are no
// longer in createModelRegistry() (their weight files were never bundled —
// see registry.ts's doc comment), so tests about THEIR OWN capability
// declarations construct them directly here rather than relying on registry
// membership — their code still exists and should stay correct for the day
// weights are actually bundled and they're re-registered.

describe("real adapter capability declarations", () => {
  const models = createModelRegistry();
  const modnet = new ModNetAdapter();
  const backgroundMattingV2 = new BackgroundMattingV2Adapter();

  it("every adapter declares a unique modelId", () => {
    const ids = models.map((m) => m.capabilities.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declared media/temporal capabilities always match the implemented methods — no adapter over- or under-declares", () => {
    for (const m of models) {
      expect(m.capabilities.supportedMedia.includes("image")).toBe(typeof m.inferImage === "function");
      expect(m.capabilities.supportedMedia.includes("video")).toBe(typeof m.inferVideo === "function");
      expect(m.capabilities.supportsTemporal).toBe(typeof m.resetTemporalState === "function");
    }
  });

  it("RMBG-1.4 is flagged non-commercial (not copyleft) — a paid BRIA license could fix this one", () => {
    const rmbg = models.find((m) => m.capabilities.modelId === "rmbg-1.4")!;
    expect(rmbg.capabilities.license.commercialUse).toBe(false);
    expect(rmbg.capabilities.license.copyleft).toBeFalsy();
  });

  it("RVM is flagged copyleft, is never eligible via the commercial-use path, and never actually loads", async () => {
    const rvm = models.find((m) => m.capabilities.modelId === "rvm")!;
    expect(rvm.capabilities.license.copyleft).toBe(true);
    expect(rvm.capabilities.license.commercialUse).toBe(false);
    await expect(rvm.load()).rejects.toThrow(/GPL-3\.0/);
    const health = await rvm.healthCheck();
    expect(health.ok).toBe(false);
  });

  it("BackgroundMattingV2 declares a background-plate requirement", () => {
    expect(backgroundMattingV2.capabilities.requiredInputs).toContain("background-plate");
  });

  it("U²-Net and MODNet are commercially usable, unlike RMBG-1.4 — this is the Phase 1 swap", () => {
    const u2net = models.find((m) => m.capabilities.modelId === "u2net")!;
    expect(u2net.capabilities.license.commercialUse).toBe(true);
    expect(modnet.capabilities.license.commercialUse).toBe(true);
  });

  it("keeps SEGMENTATION and MATTING genuinely separate: MODNet is matting-class, U²-Net and the selfie segmenter are segmentation-class", () => {
    const u2net = models.find((m) => m.capabilities.modelId === "u2net")!;
    const selfie = models.find((m) => m.capabilities.modelId === "mediapipe-selfie-segmenter")!;
    expect(modnet.capabilities.modelClass).toBe("matting");
    expect(u2net.capabilities.modelClass).toBe("segmentation");
    expect(selfie.capabilities.modelClass).toBe("segmentation");
  });

  it("none of the adapters are loaded immediately on construction — load() is a separate, explicit step", () => {
    for (const m of [...models, modnet, backgroundMattingV2]) {
      expect(m.isLoaded()).toBe(false);
    }
  });

  it("modnet and background-matting-v2 are excluded from the live registry until their weight files are actually bundled (H1)", () => {
    const ids = models.map((m) => m.capabilities.modelId);
    expect(ids).not.toContain("modnet");
    expect(ids).not.toContain("background-matting-v2");
  });
});
