import type { TimelineModel } from "../timeline/model";
import { deserializeTimeline, PROJECT_FORMAT as TIMELINE_FORMAT, serializeTimeline } from "../timeline/serialize";
import { AIResultStore } from "../ai/store";
import { normalizeProfile, type ExportProfile } from "../export/profile";
import { presetById } from "../export/presets";
import type { AssetKind, AssetRecord } from "./assets";

/**
 * PROJECT DOCUMENT (PROJECT_PERSISTENCE_ARCHITECTURE.md §2) — everything a project is, as one validated JSON value:
 *
 *   timeline        the TimelineModel through the existing strict serializer (clips, text, graphics, transforms,
 *                   crops, keyframes, effects, transitions, audio, captions, masks, matte references, guides)
 *   assets          where every sourceId's media comes from (assets.ts) — references for user media, embedded hashes
 *                   for generated media (mattes, AI images)
 *   aiResults       the AI result store (analyses the user curates; AI_EDITING_ARCHITECTURE.md §2)
 *   exportSettings  the export panel's preset + profile (EXPORT_ARCHITECTURE.md §2)
 *   ui              playhead
 *
 * Parsing VALIDATES: the timeline and AI results go through their own strict loaders, and anything invalid there
 * refuses the whole document (no half-loaded projects). Auxiliary data (export settings, UI) that fails validation
 * is replaced by defaults and reported as a warning. Older formats migrate: a bare `clipbench-timeline` save (the
 * pre-Phase-17 Save button) opens as a project with no asset records — its sources show up as missing, to relink.
 */

export const PROJECT_DOC_FORMAT = "clipbench-project";
export const PROJECT_DOC_VERSION = 1;

export interface ExportSettingsState {
  presetId: string;
  profile: ExportProfile;
  modified: boolean;
}

export interface ProjectDocument {
  format: typeof PROJECT_DOC_FORMAT;
  version: number;
  id: string;
  name: string;
  createdAt: string;
  /** When this revision was written. */
  savedAt: string;
  /** Monotonic per project: every persisted state (save or autosave) gets the next number. */
  revision: number;
  timeline: TimelineModel;
  assets: AssetRecord[];
  /** `AIResultStore.serialize()` output, parsed. Null = no AI results. */
  aiResults: unknown | null;
  exportSettings: ExportSettingsState | null;
  ui: { frame: number };
}

export class ProjectDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDocumentError";
  }
}

/** Canonical JSON. The timeline is written through serializeTimeline (its own versioned envelope). */
export function serializeProjectDocument(doc: ProjectDocument): string {
  return JSON.stringify({ ...doc, timeline: JSON.parse(serializeTimeline(doc.timeline)) });
}

export interface ParsedProject {
  doc: ProjectDocument;
  warnings: string[];
  /** The input was an older format and was upgraded. */
  migratedFrom: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ASSET_KINDS: readonly AssetKind[] = ["video", "image", "audio", "still", "sequence", "matte-track"];

export function parseProjectDocument(json: string, fallback: { id: () => string; now: () => string } = { id: () => `project-${Date.now().toString(36)}`, now: () => new Date().toISOString() }): ParsedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProjectDocumentError("The project data isn't valid JSON.");
  }
  if (!isObj(raw)) throw new ProjectDocumentError("The project data is not an object.");

  // Migration: a bare timeline save from before Phase 17.
  if (raw.format === TIMELINE_FORMAT) {
    const timeline = loadTimeline(json);
    const now = fallback.now();
    return {
      doc: { format: PROJECT_DOC_FORMAT, version: PROJECT_DOC_VERSION, id: fallback.id(), name: "Untitled project", createdAt: now, savedAt: now, revision: 0, timeline, assets: [], aiResults: null, exportSettings: null, ui: { frame: 0 } },
      warnings: ["This is an older timeline-only save: media locations weren't recorded, so every media file has to be relinked once."],
      migratedFrom: `${TIMELINE_FORMAT} v${String(raw.version)}`,
    };
  }

  if (raw.format !== PROJECT_DOC_FORMAT) throw new ProjectDocumentError("Not a Clipbench project.");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) throw new ProjectDocumentError("The project has no valid format version.");
  if (raw.version > PROJECT_DOC_VERSION) throw new ProjectDocumentError(`This project was saved by a newer version of the app (format ${raw.version}; this build reads up to ${PROJECT_DOC_VERSION}).`);
  for (const k of ["id", "name", "createdAt", "savedAt"] as const) if (typeof raw[k] !== "string") throw new ProjectDocumentError(`The project's "${k}" is missing.`);
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0) throw new ProjectDocumentError("The project's revision is invalid.");
  if (!isObj(raw.timeline)) throw new ProjectDocumentError("The project has no timeline.");
  const timeline = loadTimeline(JSON.stringify(raw.timeline));

  if (!Array.isArray(raw.assets)) throw new ProjectDocumentError("The project's asset list is missing.");
  const assets = raw.assets.map((a, i) => validateAsset(a, i));
  if (new Set(assets.map((a) => a.id)).size !== assets.length) throw new ProjectDocumentError("The project lists the same asset twice.");

  let aiResults: unknown = null;
  if (raw.aiResults !== null && raw.aiResults !== undefined) {
    try {
      new AIResultStore().load(JSON.stringify(raw.aiResults));
    } catch (e) {
      throw new ProjectDocumentError(`The project's AI results are invalid: ${(e as Error).message}`);
    }
    aiResults = raw.aiResults;
  }

  const warnings: string[] = [];
  let exportSettings: ExportSettingsState | null = null;
  if (raw.exportSettings !== null && raw.exportSettings !== undefined) {
    const e = raw.exportSettings;
    if (isObj(e) && typeof e.presetId === "string" && presetById(e.presetId) && isObj(e.profile)) {
      try {
        exportSettings = { presetId: e.presetId, profile: normalizeProfile(e.profile as unknown as ExportProfile), modified: !!e.modified };
      } catch {
        warnings.push("The saved export settings couldn't be read; the default preset is used.");
      }
    } else warnings.push("The saved export settings couldn't be read; the default preset is used.");
  }
  let ui = { frame: 0 };
  if (isObj(raw.ui) && typeof raw.ui.frame === "number" && Number.isInteger(raw.ui.frame) && raw.ui.frame >= 0) ui = { frame: raw.ui.frame };
  else if (raw.ui !== undefined) warnings.push("The saved playhead position was invalid; it starts at 0.");

  return {
    doc: { format: PROJECT_DOC_FORMAT, version: PROJECT_DOC_VERSION, id: raw.id as string, name: raw.name as string, createdAt: raw.createdAt as string, savedAt: raw.savedAt as string, revision: raw.revision, timeline, assets, aiResults, exportSettings, ui },
    warnings,
    migratedFrom: raw.version < PROJECT_DOC_VERSION ? `${PROJECT_DOC_FORMAT} v${raw.version}` : null,
  };
}

function loadTimeline(json: string): TimelineModel {
  try {
    return deserializeTimeline(json);
  } catch (e) {
    throw new ProjectDocumentError(`The project's timeline is invalid: ${(e as Error).message}`);
  }
}

function validateAsset(a: unknown, i: number): AssetRecord {
  const bad = (why: string): never => {
    throw new ProjectDocumentError(`Asset ${i + 1} is invalid: ${why}.`);
  };
  if (!isObj(a)) bad("not an object");
  const r = a as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) bad("no id");
  if (!ASSET_KINDS.includes(r.kind as AssetKind)) bad(`unknown kind "${String(r.kind)}"`);
  if (typeof r.label !== "string") bad("no label");
  const o = r.origin;
  if (!isObj(o)) bad("no origin");
  const origin = o as Record<string, unknown>;
  if (origin.type === "file") {
    if (typeof origin.name !== "string" || typeof origin.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(origin.fingerprint) || typeof origin.size !== "number" || typeof origin.lastModified !== "number" || typeof origin.mimeType !== "string") bad("file reference incomplete");
  } else if (origin.type === "url") {
    if (typeof origin.url !== "string") bad("no url");
  } else if (origin.type === "generated") {
    if (typeof origin.generator !== "string" || !Array.isArray(origin.frames) || origin.frames.length === 0) bad("generated media has no frames");
    for (const f of origin.frames as unknown[]) {
      const ff = f as Record<string, unknown>;
      if (!isObj(f) || !Number.isInteger(ff.frame) || typeof ff.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ff.sha256) || !Number.isInteger(ff.width) || !Number.isInteger(ff.height) || !Number.isInteger(ff.size)) bad("generated frame entry incomplete");
    }
    if (r.kind === "still" && (origin.frames as unknown[]).length !== 1) bad("a still has exactly one frame");
  } else bad(`unknown origin "${String(origin.type)}"`);
  if (r.media !== undefined && !isObj(r.media)) bad("media info is not an object");
  return { id: r.id as string, kind: r.kind as AssetKind, label: r.label as string, origin: o as AssetRecord["origin"], media: r.media as AssetRecord["media"] };
}

/** Bundle entry name of a generated blob (historically always a PNG, hence the extension; matte-track chunks reuse it — readers go by the asset kind, never the name). */
export const blobEntryName = (sha256: string) => `blobs/${sha256}.png`;
export const DOCUMENT_ENTRY = "project.json";
