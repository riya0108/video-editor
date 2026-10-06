import type { ClipAnimation, KeyframeTrack } from "../animation/keyframes";
import { getEffectDefinition, isEffectType, type EffectType } from "./registry";

/**
 * EFFECT MODEL (EFFECTS_ENGINE_ARCHITECTURE.md §2). Pure data on the clip:
 * `clip.effects` is the ordered stack (index = order, top runs first). Effect
 * keyframes live in the clip's existing `animation` at
 * `effects.<effectId>.<param>` — the Phase 8 engine, not a new one.
 */
export interface Effect {
  id: string;
  type: EffectType;
  params: Record<string, number>;
  enabled: boolean;
  metadata?: { label?: string; [k: string]: unknown };
}

export const EFFECT_PATH_PREFIX = "effects.";

export function effectParamPath(effectId: string, param: string): string {
  return `${EFFECT_PATH_PREFIX}${effectId}.${param}`;
}

/** "effects.<id>.<param>" -> { effectId, param } (ids never contain dots). */
export function parseEffectPath(path: string): { effectId: string; param: string } | null {
  if (!path.startsWith(EFFECT_PATH_PREFIX)) return null;
  const rest = path.slice(EFFECT_PATH_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { effectId: rest.slice(0, dot), param: rest.slice(dot + 1) };
}

/** Clamps a value to its param definition (non-finite -> default). */
export function clampParam(type: EffectType, key: string, value: unknown): number {
  const def = getEffectDefinition(type)?.params.find((p) => p.key === key);
  if (!def) return NaN;
  if (typeof value !== "number" || !Number.isFinite(value)) return def.default;
  return Math.min(def.max, Math.max(def.min, value));
}

/** Complete, validated params: every defined param present and clamped; unknown keys dropped. */
export function normalizeParams(type: EffectType, raw: unknown): Record<string, number> {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const p of getEffectDefinition(type)!.params) out[p.key] = clampParam(type, p.key, r[p.key]);
  return out;
}

/** Validates one effect from untrusted data; null if unusable. */
export function normalizeEffect(raw: unknown): Effect | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.includes(".") || !isEffectType(r.type)) return null;
  const e: Effect = { id: r.id, type: r.type, params: normalizeParams(r.type, r.params), enabled: typeof r.enabled === "boolean" ? r.enabled : true };
  if (typeof r.metadata === "object" && r.metadata !== null) e.metadata = r.metadata as Effect["metadata"];
  return e;
}

/** The keyframe tracks that animate one effect's params (the abstraction's `keyframes` field, as a view). */
export function effectKeyframes(animation: ClipAnimation | undefined, effectId: string): Record<string, KeyframeTrack> {
  const out: Record<string, KeyframeTrack> = {};
  for (const [path, track] of Object.entries(animation?.tracks ?? {})) {
    const p = parseEffectPath(path);
    if (p?.effectId === effectId) out[p.param] = track;
  }
  return out;
}
