/**
 * AI ERROR HANDLING (AI_EDITING_ARCHITECTURE.md §5). Every failure a provider or job can hit is normalized into ONE
 * error type with a typed code, a user-presentable message and whether retrying could help. Providers throw
 * AIError; anything else they throw is wrapped as "inference-failed" (never swallowed, never turned into an empty
 * "success").
 */
export type AIErrorCode =
  /** No provider registered/available for the feature in this environment (e.g. no WebGL/WASM, model missing). */
  | "provider-unavailable"
  /** The model's weights or runtime failed to load (network, CORS, corrupt file). */
  | "model-load-failed"
  /** The request itself is invalid (no clip, wrong kind, empty region...). */
  | "invalid-input"
  /** The target media isn't loaded / can't be decoded / has no audio. */
  | "media-unavailable"
  /** The provider ran and failed. */
  | "inference-failed"
  /** The analysis ran but there is nothing usable (e.g. no speech for filler detection). */
  | "no-result"
  /** Cancelled by the user (or superseded). */
  | "cancelled"
  /** Exceeded the job's time limit. */
  | "timeout";

const RETRYABLE: Record<AIErrorCode, boolean> = {
  "provider-unavailable": false,
  "model-load-failed": true,
  "invalid-input": false,
  "media-unavailable": true,
  "inference-failed": true,
  "no-result": false,
  cancelled: true,
  timeout: true,
};

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: AIErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.cause = cause;
  }
}

export function isAbort(e: unknown): boolean {
  return (e instanceof AIError && e.code === "cancelled") || (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError");
}

/** Normalizes anything thrown into an AIError. */
export function toAIError(e: unknown): AIError {
  if (e instanceof AIError) return e;
  if (isAbort(e)) return new AIError("cancelled", "Cancelled.", e);
  const msg = e instanceof Error ? e.message : String(e);
  return new AIError("inference-failed", msg || "The analysis failed.", e);
}

/** Throws a "cancelled" AIError when the signal is aborted — providers call this between units of work. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AIError("cancelled", "Cancelled.");
}
