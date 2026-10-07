import type { AIFeatureId, AIResultItem, ModelInfo, ProviderKind } from "./types";
import type { AIMediaSource } from "./media";

/**
 * AI PROVIDER ABSTRACTION (AI_EDITING_ARCHITECTURE.md §3). One interface for every capability, whether it's a
 * neural network, a classical algorithm or a heuristic. A feature is ONE provider module; swapping in a better
 * model later (a neural diarizer, an inpainting network, a cloud API) is registering another provider for the same
 * feature id — the job system, result model, store, UI and apply actions don't change.
 */

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the audio handed to `transcribe`. */
  start: number;
  end: number;
}

/** Shared services a provider may need (injected, so providers stay testable and modular). */
export interface AIServices {
  /** Speech-to-text on 16 kHz mono PCM -> word timings. Wired to the app's in-browser Whisper. */
  transcribe?: (pcm16k: Float32Array, onProgress?: (fraction: number) => void) => Promise<TranscriptWord[]>;
  /** Turns an RGBA buffer into a drawable image and registers it as a frame-provider source; returns its id. */
  registerImage?: (id: string, rgba: Uint8ClampedArray, width: number, height: number) => string;
}

export interface AIRunContext {
  signal: AbortSignal;
  /** 0..1 plus an optional human-readable stage. */
  progress: (fraction: number, stage?: string) => void;
  services: AIServices;
}

export interface AIRequest<P = Record<string, unknown>> {
  feature: AIFeatureId;
  clipId: string;
  sourceId: string;
  media: AIMediaSource;
  params: P;
}

export interface ProviderOutput {
  items: AIResultItem[];
  warnings: string[];
  metrics?: Record<string, number>;
  /** The parameters actually used (defaults filled in). */
  params?: Record<string, unknown>;
}

export type Availability = { available: true } | { available: false; reason: string };

export interface AIProvider<P = Record<string, unknown>> {
  id: string;
  feature: AIFeatureId;
  label: string;
  kind: ProviderKind;
  model?: ModelInfo;
  /** One sentence on what it does and its limits — shown in the capability list. */
  description: string;
  /** What the request needs (checked before queueing so a job can't fail on a missing input). */
  needs: { video?: boolean; audio?: boolean; transcribe?: boolean; region?: boolean };
  availability(services: AIServices): Promise<Availability> | Availability;
  run(req: AIRequest<P>, ctx: AIRunContext): Promise<ProviderOutput>;
}

let itemCounter = 0;
/** Item ids are unique within a session (results persist their own ids). */
export function itemId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${itemCounter}`;
}
