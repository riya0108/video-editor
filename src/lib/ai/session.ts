import type { Clip } from "../timeline/clip";
import { AIError } from "./errors";
import { AIJobQueue } from "./jobs";
import type { AIMediaSource } from "./media";
import type { AIServices } from "./provider";
import type { AIRegistry } from "./registry";
import { AIResultStore } from "./store";
import type { AIFeatureId } from "./types";

/**
 * AI EDITING SESSION — the editor-facing facade: registry + job queue + result store + services. `run()` validates a
 * request BEFORE queueing (provider available, clip has the media the provider needs, region given when required),
 * so a job fails only for reasons that genuinely happen while running.
 */
export class AIEditingSession {
  readonly store = new AIResultStore();
  readonly queue: AIJobQueue;

  constructor(
    readonly registry: AIRegistry,
    readonly services: AIServices,
    private readonly mediaFor: (clip: Clip) => AIMediaSource,
    opts: { concurrency?: number; timeoutMs?: number } = {},
  ) {
    this.queue = new AIJobQueue(services, (r) => this.store.add(r), opts);
  }

  async run(feature: AIFeatureId, clip: Clip, params: Record<string, unknown> = {}): Promise<string> {
    const picked = await this.registry.pick(feature, this.services);
    if (!picked.provider) throw new AIError("provider-unavailable", picked.reason);
    const p = picked.provider;
    if (clip.content.kind === "text" || clip.content.kind === "caption" || (clip.content.kind === "graphic" && !clip.content.source)) throw new AIError("invalid-input", "AI analysis works on video, image and audio layers.");
    let media: AIMediaSource;
    try {
      media = this.mediaFor(clip);
    } catch (e) {
      throw new AIError("media-unavailable", (e as Error).message, e);
    }
    if (p.needs.video && !media.hasVideo) throw new AIError("media-unavailable", `${p.label} needs a clip with picture.`);
    if ((p.needs.audio || p.needs.transcribe) && !media.hasAudio) throw new AIError("media-unavailable", `${p.label} needs a clip with decoded audio.`);
    if (p.needs.region && !(params.region && (params.region as { w: number }).w > 0)) throw new AIError("invalid-input", `${p.label} needs a region — draw one or pick a detected object.`);
    const sourceId = (clip.content as { source: { sourceId: string } }).source.sourceId;
    return this.queue.submit(p, { feature, clipId: clip.id, sourceId, media, params }, `${p.label} · ${(clip.content as { source?: { label?: string } }).source?.label ?? clip.id}`);
  }
}
