import type { AIProvider, AIServices, Availability } from "./provider";
import { AI_FEATURES, type AIFeatureId } from "./types";
import { silenceProvider } from "./features/silence";
import { sceneProvider, shotProvider } from "./features/shots";
import { trackingProvider } from "./features/tracking";
import { objectRemovalProvider } from "./features/object-removal";
import { speakerProvider } from "./features/speakers";
import { fillerProvider } from "./features/fillers";
import { brollProvider } from "./features/broll";
import { highlightProvider } from "./features/highlights";
import { createDetectionProvider, type DetectorBackend } from "./features/detection";
import { createReframeProvider } from "./features/reframe";
import type { ModelInfo } from "./types";

/**
 * PROVIDER REGISTRY (AI_EDITING_ARCHITECTURE.md §3). Features map to providers; the first AVAILABLE provider for a
 * feature runs. `capabilities()` reports every feature honestly — which provider, what kind (model / classical /
 * heuristic), and if unavailable, why — so the UI never offers something that isn't connected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- providers differ in their params type; requests carry the right params per feature
export type AnyProvider = AIProvider<any>;

export class AIRegistry {
  private readonly providers: AnyProvider[] = [];

  register(p: AnyProvider): this {
    if (this.providers.some((x) => x.id === p.id)) throw new Error(`AI provider "${p.id}" is already registered.`);
    this.providers.push(p);
    return this;
  }

  providersFor(feature: AIFeatureId): AnyProvider[] {
    return this.providers.filter((p) => p.feature === feature);
  }

  async pick(feature: AIFeatureId, services: AIServices): Promise<{ provider: AnyProvider } | { provider: null; reason: string }> {
    const list = this.providersFor(feature);
    if (list.length === 0) return { provider: null, reason: "No provider is registered for this feature." };
    const reasons: string[] = [];
    for (const p of list) {
      const a = await p.availability(services);
      if (a.available) return { provider: p };
      reasons.push(`${p.label}: ${a.reason}`);
    }
    return { provider: null, reason: reasons.join(" ") };
  }

  async capabilities(services: AIServices): Promise<{ feature: AIFeatureId; provider: AnyProvider | null; availability: Availability }[]> {
    return Promise.all(
      AI_FEATURES.map(async (feature) => {
        const r = await this.pick(feature, services);
        return r.provider ? { feature, provider: r.provider, availability: { available: true as const } } : { feature, provider: this.providersFor(feature)[0] ?? null, availability: { available: false as const, reason: r.reason } };
      }),
    );
  }
}

export interface DetectorEnvironment {
  loadFace: () => Promise<DetectorBackend>;
  loadObject: () => Promise<DetectorBackend>;
  available: () => Availability;
  faceModel: ModelInfo;
  objectModel: ModelInfo;
}

/** The app's registry: every feature module, with detectors from the given environment (MediaPipe in the browser). */
export function createDefaultRegistry(env: DetectorEnvironment): AIRegistry {
  return new AIRegistry()
    .register(shotProvider)
    .register(sceneProvider)
    .register(
      createDetectionProvider({
        id: "objects.efficientdet-lite0",
        feature: "object-detection",
        label: "Object detection",
        description: "Finds and follows objects of 80 everyday classes (people, cars, dogs, cups, laptops…) with EfficientDet-Lite0.",
        model: env.objectModel,
        load: env.loadObject,
        available: env.available,
        defaultSamplesPerSecond: 2,
      }) as AIProvider,
    )
    .register(
      createDetectionProvider({
        id: "faces.blazeface",
        feature: "face-detection",
        label: "Face detection",
        description: "Finds and follows faces with MediaPipe BlazeFace (short range: faces filling a good part of the frame, e.g. talking heads).",
        model: env.faceModel,
        load: env.loadFace,
        available: env.available,
        defaultSamplesPerSecond: 4,
      }) as AIProvider,
    )
    .register(speakerProvider)
    .register(silenceProvider)
    .register(fillerProvider)
    .register(createReframeProvider(env.loadFace, env.loadObject, env.available))
    .register(highlightProvider)
    .register(objectRemovalProvider)
    .register(trackingProvider)
    .register(brollProvider);
}
