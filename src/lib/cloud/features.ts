import { CREDIT_USD } from "./config";

/**
 * CLOUD FEATURE REGISTRY — shared by the server (estimates, validation, gating) and the browser (labels, prices).
 * Each feature declares its price as an ESTIMATE in credits (1 credit = $0.01 of provider cost, with the safety margin
 * PHASE4_PLAN.md §2 calls for). The server reserves the estimate, and the job is charged its actual cost, never more.
 *
 * M0 ships only `echo`, a free-of-provider-cost test feature (dev flag) that exercises the whole pipeline:
 * reserve -> queue -> worker -> settle/fail/refund. Real features (translation, scripts, images, voice...) are added in
 * M1+ by registering here and adding a runner in runners.ts.
 */

export interface Estimate {
  credits: number;
  usd: number;
}

export interface CloudFeature<P = unknown> {
  id: string;
  label: string;
  /** Voice, dubbing and lip sync require an account (approved 2026-10-27); text and image features don't. */
  requiresSignIn: boolean;
  /** Sends user media to the server: the first-use consent dialog must have been accepted. */
  uploadsMedia: boolean;
  /** Development-only (PUBLIC_CLOUD_DEV_FEATURES=true). */
  devOnly?: boolean;
  /** Validates and normalizes request params from the browser (untrusted). Throws a message for the user. */
  parse(raw: unknown): P;
  estimate(params: P): Estimate;
}

export class FeatureParamsError extends Error {}

const credits = (usd: number) => Math.max(1, Math.ceil((usd * 1.5) / CREDIT_USD));

export interface EchoParams {
  text: string;
  /** Test hooks: make the worker fail (to exercise refunds) or take a while (to exercise cancel/queue). */
  fail?: boolean;
  delayMs?: number;
}

export const echoFeature: CloudFeature<EchoParams> = {
  id: "echo",
  label: "Cloud check (test)",
  requiresSignIn: false,
  uploadsMedia: false,
  devOnly: true,
  parse(raw) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.text !== "string" || r.text.length === 0 || r.text.length > 200) throw new FeatureParamsError("Send 1–200 characters of text.");
    return { text: r.text, fail: r.fail === true, delayMs: typeof r.delayMs === "number" ? Math.min(10_000, Math.max(0, r.delayMs)) : 0 };
  },
  estimate: () => ({ credits: credits(0.0001), usd: 0.0001 }),
};

export const CLOUD_FEATURES: readonly CloudFeature<never>[] = [echoFeature as CloudFeature<never>];

export function getFeature(id: string): CloudFeature<unknown> | undefined {
  return CLOUD_FEATURES.find((f) => f.id === id) as CloudFeature<unknown> | undefined;
}
