import { describe, it, expect } from "vitest";
import { EdgeCategory, EDGE_CATEGORY_NAMES, getEdgeRefinementGuidance } from "./edge-category";

describe("getEdgeRefinementGuidance", () => {
  it("HARD_EDGE prioritizes geometric accuracy: positive sharpness bias, minimal smoothing", () => {
    const g = getEdgeRefinementGuidance(EdgeCategory.HardEdge);
    expect(g.edgeSharpnessBias).toBeGreaterThan(0);
    expect(g.smoothingRadiusMultiplier).toBeLessThan(0.5);
  });

  it("SOFT_EDGE preserves the gradual transition: negative sharpness bias, not maximally suppressed smoothing", () => {
    const g = getEdgeRefinementGuidance(EdgeCategory.SoftEdge);
    expect(g.edgeSharpnessBias).toBeLessThan(0);
  });

  it("HAIR and FUR both recommend routing to hair refinement", () => {
    expect(getEdgeRefinementGuidance(EdgeCategory.Hair).recommendHairRefinement).toBe(true);
    expect(getEdgeRefinementGuidance(EdgeCategory.Fur).recommendHairRefinement).toBe(true);
  });

  it("TRANSLUCENT never caps alpha and biases away from sharpening (preserve partial opacity)", () => {
    const g = getEdgeRefinementGuidance(EdgeCategory.Translucent);
    expect(g.maxAutoAlpha).toBe(1);
    expect(g.edgeSharpnessBias).toBeLessThan(0);
  });

  it("SHADOW caps automatic alpha below 1 — never auto-resolves to solid foreground", () => {
    const g = getEdgeRefinementGuidance(EdgeCategory.Shadow);
    expect(g.maxAutoAlpha).toBeLessThan(1);
  });

  it("REFLECTION caps automatic alpha, reduces decontamination trust, and flags for review — 'treat cautiously'", () => {
    const g = getEdgeRefinementGuidance(EdgeCategory.Reflection);
    expect(g.maxAutoAlpha).toBeLessThan(1);
    expect(g.decontaminationStrengthMultiplier).toBeLessThan(1);
    expect(g.flagForManualReview).toBe(true);
  });

  it("UNCERTAIN always flags for stronger refinement or manual review", () => {
    expect(getEdgeRefinementGuidance(EdgeCategory.Uncertain).flagForManualReview).toBe(true);
  });

  it("every category has a name and a guidance entry", () => {
    const categories = [
      EdgeCategory.HardEdge,
      EdgeCategory.SoftEdge,
      EdgeCategory.Hair,
      EdgeCategory.Fur,
      EdgeCategory.Translucent,
      EdgeCategory.MotionBlur,
      EdgeCategory.Shadow,
      EdgeCategory.Reflection,
      EdgeCategory.Uncertain,
    ];
    for (const c of categories) {
      expect(typeof EDGE_CATEGORY_NAMES[c]).toBe("string");
      const g = getEdgeRefinementGuidance(c);
      expect(g.maxAutoAlpha).toBeGreaterThan(0);
      expect(g.maxAutoAlpha).toBeLessThanOrEqual(1);
      expect(g.decontaminationStrengthMultiplier).toBeGreaterThan(0);
      expect(g.decontaminationStrengthMultiplier).toBeLessThanOrEqual(1);
    }
  });
});
