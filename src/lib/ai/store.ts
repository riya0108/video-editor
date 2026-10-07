import type { AIResult, AIResultItem, Box } from "./types";
import { AI_FEATURES } from "./types";

/**
 * AI RESULT STORE (AI_EDITING_ARCHITECTURE.md §2). Results are editor DATA the user curates before (or instead of)
 * applying them: accept/reject items, fix a time range or a box, rename a speaker, delete false positives. Edits are
 * validated (ranges stay ordered and inside the analysed span, boxes inside the frame). The store is separate from
 * the timeline on purpose: analysing never edits the project; only an explicit apply action does (through
 * TimelineEngine, one undo step). Serializable for saving alongside a project.
 */

export type ItemPatch = {
  accepted?: boolean;
  start?: number;
  end?: number;
  speaker?: string;
  label?: string;
  text?: string;
  keywords?: string[];
  query?: string;
  box?: Box;
};

type Listener = () => void;

export class AIResultStore {
  private readonly results = new Map<string, AIResult>();
  private readonly listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  add(result: AIResult): void {
    this.results.set(result.id, result);
    this.emit();
  }

  get(id: string): AIResult | undefined {
    return this.results.get(id);
  }

  list(filter?: { clipId?: string; feature?: AIResult["feature"] }): AIResult[] {
    return [...this.results.values()].filter((r) => (!filter?.clipId || r.target.clipId === filter.clipId) && (!filter?.feature || r.feature === filter.feature)).sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): void {
    if (this.results.delete(id)) this.emit();
  }

  /** Latest result of a feature for a clip (what apply actions use by default). */
  latest(clipId: string, feature: AIResult["feature"]): AIResult | undefined {
    return this.list({ clipId, feature })[0];
  }

  updateItem(resultId: string, itemId: string, patch: ItemPatch): AIResultItem {
    const r = this.results.get(resultId);
    if (!r) throw new Error(`No AI result "${resultId}".`);
    const idx = r.items.findIndex((i) => i.id === itemId);
    if (idx < 0) throw new Error(`No item "${itemId}" in result "${resultId}".`);
    const next = applyItemPatch(r.items[idx], patch, r.target.sourceStart, r.target.sourceEnd);
    const items = [...r.items];
    items[idx] = next;
    this.results.set(resultId, { ...r, items });
    this.emit();
    return next;
  }

  removeItem(resultId: string, itemId: string): void {
    const r = this.results.get(resultId);
    if (!r) return;
    this.results.set(resultId, { ...r, items: r.items.filter((i) => i.id !== itemId) });
    this.emit();
  }

  setAllAccepted(resultId: string, accepted: boolean): void {
    const r = this.results.get(resultId);
    if (!r) return;
    this.results.set(resultId, { ...r, items: r.items.map((i) => ({ ...i, accepted })) });
    this.emit();
  }

  serialize(): string {
    return JSON.stringify({ format: "clipbench-ai-results", version: 1, results: [...this.results.values()] });
  }

  /** Replaces the store's contents from JSON; invalid entries are rejected as a whole (returns the count loaded). */
  load(json: string): number {
    const parsed = JSON.parse(json) as { format?: string; version?: number; results?: unknown };
    if (parsed.format !== "clipbench-ai-results" || parsed.version !== 1 || !Array.isArray(parsed.results)) throw new Error("Not an AI results file.");
    const valid: AIResult[] = [];
    for (const r of parsed.results as AIResult[]) {
      if (!r || typeof r.id !== "string" || !AI_FEATURES.includes(r.feature) || !Array.isArray(r.items) || !r.target || typeof r.target.clipId !== "string") throw new Error("Invalid AI result in file.");
      valid.push(r);
    }
    this.results.clear();
    for (const r of valid) this.results.set(r.id, r);
    this.emit();
    return valid.length;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Validated item edit (pure). Throws on an impossible edit (start >= end, non-finite values, a field the item doesn't have). */
export function applyItemPatch(item: AIResultItem, patch: ItemPatch, spanStart: number, spanEnd: number): AIResultItem {
  const next = { ...item } as AIResultItem & Record<string, unknown>;
  if (patch.accepted !== undefined) next.accepted = !!patch.accepted;
  const hasRange = "start" in item && "end" in item && item.kind !== "detection-track";
  if (patch.start !== undefined || patch.end !== undefined) {
    if (!hasRange) throw new Error(`"${item.kind}" items have no editable time range.`);
    const s = patch.start ?? (item as { start: number }).start;
    const e = patch.end ?? (item as { end: number }).end;
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("Times must be finite.");
    const cs = clamp(s, spanStart, spanEnd);
    const ce = clamp(e, spanStart, spanEnd);
    if (!(ce > cs)) throw new Error("An item must end after it starts.");
    next.start = +cs.toFixed(3);
    next.end = +ce.toFixed(3);
    next.edited = true;
  }
  const setString = (key: "speaker" | "label" | "text" | "query", allowed: boolean) => {
    const v = patch[key];
    if (v === undefined) return;
    if (!allowed) throw new Error(`"${item.kind}" items have no "${key}".`);
    const s = String(v).trim().slice(0, 200);
    if (!s) throw new Error(`"${key}" can't be empty.`);
    next[key] = s;
    next.edited = true;
  };
  setString("speaker", item.kind === "speaker-turn");
  setString("label", item.kind === "detection-track" || item.kind === "track");
  setString("text", item.kind === "filler");
  setString("query", item.kind === "broll");
  if (patch.keywords !== undefined) {
    if (item.kind !== "broll") throw new Error(`"${item.kind}" items have no keywords.`);
    next.keywords = patch.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 12);
    next.edited = true;
  }
  if (patch.box !== undefined) {
    if (item.kind !== "object-removal") throw new Error(`"${item.kind}" items have no editable box.`);
    const b = patch.box;
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) throw new Error("Invalid box.");
    const x = clamp(b.x, 0, 1);
    const y = clamp(b.y, 0, 1);
    next.region = { x, y, w: clamp(b.w, 0.001, 1 - x), h: clamp(b.h, 0.001, 1 - y) };
    next.edited = true;
  }
  return next as AIResultItem;
}
