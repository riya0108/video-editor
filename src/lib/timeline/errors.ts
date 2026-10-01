export type TimelineEditErrorReason =
  | "track-not-found"
  | "clip-not-found"
  | "track-locked"
  | "kind-mismatch"
  | "overlap"
  | "out-of-range"
  | "invalid-split-point"
  | "invalid-track-index";

/**
 * Thrown by every mutating function in operations.ts. Deliberately a single
 * error class with a typed `reason` (not a different Error subclass per
 * case) — callers that want to react differently per failure (e.g.
 * TimelineEngine converting this into a Result) switch on `reason`, while
 * callers that don't care can just catch TimelineEditError.
 */
export class TimelineEditError extends Error {
  readonly reason: TimelineEditErrorReason;

  constructor(reason: TimelineEditErrorReason, message: string) {
    super(message);
    this.name = "TimelineEditError";
    this.reason = reason;
  }
}
