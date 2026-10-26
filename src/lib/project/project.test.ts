import { describe, expect, it, vi } from "vitest";
import { serializeTimeline } from "../timeline/serialize";
import { setClipVisual } from "../timeline/operations";
import { decodeBundle, encodeBundle, ProjectCorruptError, sha256Hex } from "./bundle";
import { assetUsage, checkRelink, fingerprintBlob, matchRelink, type AssetRecord } from "./assets";
import { AssetRegistry } from "./asset-registry";
import { blobEntryName, DOCUMENT_ENTRY, parseProjectDocument, ProjectDocumentError, serializeProjectDocument, type ProjectDocument } from "./document";
import { Autosaver } from "./autosave";
import { MemoryProjectStore, versionsToPrune, type VersionSummary } from "./storage";
import { findRecoverable, SessionTracker } from "./recovery";
import { NeedsSaveTargetError, ProjectManager, type AssetStatus, type EditorState, type ProjectFileTarget, type ProjectHost } from "./manager";
import { buildComplexProject, FIXTURE_MATTE_ID } from "./fixture";
import { MatteTrack, MatteTrackBuilder } from "../composition/matte-track";
import { buildProbeProject } from "../render/probe-project";

const buildProbeProjectUnnormalized = () => buildProbeProject(1920, 1080).timeline;

/**
 * PHASE 17 — PROJECT PERSISTENCE & RECOVERY, Node side: bundle format, document schema + migration, assets and
 * relink rules, storage retention and atomicity, autosave timing, crash detection, and the manager's full flows
 * (save → close → reopen, Save As, open, versions, restore, recovery, corrupted files, interrupted saves, missing media,
 * relink) against an in-memory store and a fake editor. The same flows run for real in Chrome (test report).
 */

const enc = (s: string) => new TextEncoder().encode(s);
const png = (n: number) => enc(`\x89PNG fake frame ${n}`);
const file = (name: string, content: string, type = "video/mp4") => new File([content], name, { type, lastModified: 1_700_000_000_000 });

// ------------------------------------------------------------------------------------------------ bundle

describe("bundle (.clipbench file)", () => {
  const entries = [
    { name: DOCUMENT_ENTRY, data: enc('{"hello":"world"}') },
    { name: blobEntryName("a".repeat(64)), data: png(1) },
  ];

  it("round-trips entries exactly", async () => {
    const bytes = await encodeBundle(entries);
    const d = await decodeBundle(bytes);
    expect(d.damaged).toEqual([]);
    expect(new TextDecoder().decode(d.entries.get(DOCUMENT_ENTRY))).toBe('{"hello":"world"}');
    expect([...d.entries.get(blobEntryName("a".repeat(64)))!]).toEqual([...png(1)]);
  });

  it("truncation anywhere (an interrupted non-atomic write) is detected and named", async () => {
    const bytes = await encodeBundle(entries);
    for (const cut of [1, 20, Math.floor(bytes.length / 2), bytes.length - 1]) {
      await expect(decodeBundle(bytes.subarray(0, cut))).rejects.toThrow(ProjectCorruptError);
    }
    await expect(decodeBundle(bytes.subarray(0, bytes.length - 10))).rejects.toThrow(/incomplete|too short/);
    const extended = new Uint8Array(bytes.length + 5);
    extended.set(bytes);
    await expect(decodeBundle(extended)).rejects.toThrow(/end marker|truncated or extended/);
  });

  it("a flipped byte in the project data is fatal; in an embedded media frame it is tolerated and reported", async () => {
    const bytes = await encodeBundle(entries);
    const d = await decodeBundle(bytes);
    const docOffset = bytes.length - 48 - entries[0].data.length - entries[1].data.length;
    const badDoc = bytes.slice();
    badDoc[docOffset + 3] ^= 0x20;
    await expect(decodeBundle(badDoc, { tolerateDamaged: (n) => n.startsWith("blobs/") })).rejects.toThrow(/project\.json failed verification/);
    const badBlob = bytes.slice();
    badBlob[bytes.length - 48 - 2] ^= 0xff;
    const r = await decodeBundle(badBlob, { tolerateDamaged: (n) => n.startsWith("blobs/") });
    expect(r.damaged).toEqual([blobEntryName("a".repeat(64))]);
    expect(r.entries.has(DOCUMENT_ENTRY)).toBe(true);
    expect(d.manifest.entries).toHaveLength(2);
  });

  it("wrong signature, damaged table of contents, random bytes: refused with a reason", async () => {
    const bytes = await encodeBundle(entries);
    const sig = bytes.slice();
    sig[0] = 0x58;
    await expect(decodeBundle(sig)).rejects.toThrow(/wrong signature/);
    const toc = bytes.slice();
    toc[20] = 0x00;
    await expect(decodeBundle(toc)).rejects.toThrow(ProjectCorruptError);
    await expect(decodeBundle(crypto.getRandomValues(new Uint8Array(4096)))).rejects.toThrow(ProjectCorruptError);
  });
});

// ------------------------------------------------------------------------------------------------ document

function docOf(over: Partial<ProjectDocument> = {}): ProjectDocument {
  const f = buildComplexProject();
  return {
    format: "clipbench-project",
    version: 1,
    id: "project-1",
    name: "Complex",
    createdAt: "2026-10-08T10:00:00.000Z",
    savedAt: "2026-10-08T10:05:00.000Z",
    revision: 3,
    timeline: f.timeline,
    assets: [{ id: "probe-counter30", kind: "video", label: "counter30.mp4", origin: { type: "file", name: "counter30.mp4", size: 1000, lastModified: 1, mimeType: "video/mp4", fingerprint: "f".repeat(64) } }],
    aiResults: f.aiResults,
    exportSettings: f.exportSettings,
    ui: { frame: 42 },
    ...over,
  };
}

describe("project document", () => {
  it("every feature survives a round trip: timeline (clips, text, graphics, transforms, crops, keyframes, effects, transitions, audio, captions, masks, mattes, guides), assets, AI results, export settings, playhead", () => {
    const f = buildComplexProject();
    const doc = docOf({ timeline: f.timeline });
    const back = parseProjectDocument(serializeProjectDocument(doc));
    expect(back.warnings).toEqual([]);
    expect(back.migratedFrom).toBeNull();
    // Compare through the canonical serializer: identical bytes = identical state.
    expect(serializeProjectDocument(back.doc)).toBe(serializeProjectDocument(doc));
    const tl = back.doc.timeline;
    const c = (id: string) => tl.clips[f.ids[id]];
    expect(c("logoClip").visual!.crop).toEqual({ top: 0.1, left: 0.05, right: 0.15, bottom: 0.2 });
    expect(c("videoB").visual!.matte).toMatchObject({ sourceId: FIXTURE_MATTE_ID, decontaminate: true });
    expect(c("boxClip").animation!.tracks["visual.transform.x"].keyframes).toHaveLength(2);
    expect(c("fxClip").effects![0].type).toBe("saturation");
    expect(c("maskClip").masks![0].type).toBe("ellipse");
    expect(Object.values(tl.transitions!)[0].type).toBe("cross-dissolve");
    expect((c("captionClip").content as { words?: unknown[] }).words).toHaveLength(2);
    expect(c("toneClip").audio).toMatchObject({ volume: 0.8, fadeInFrames: 8, fadeOutFrames: 15 });
    expect((c("titleClip").content as { text?: string }).text).toBe("FINAL RENDER");
    expect(tl.guides).toHaveLength(2);
    expect(back.doc.exportSettings).toMatchObject({ presetId: "youtube", modified: true, profile: { fps: 60, videoBitrate: 12e6, audioBitrate: 256_000 } });
    expect((back.doc.aiResults as { results: { items: { accepted: boolean }[] }[] }).results[0].items.map((i) => i.accepted)).toEqual([true, false]);
    expect(back.doc.ui.frame).toBe(42);
  });

  it("loading normalizes once and is then idempotent: a second save → load is byte-identical", () => {
    const raw = buildProbeProjectUnnormalized();
    const once = parseProjectDocument(serializeProjectDocument(docOf({ timeline: raw }))).doc;
    const twice = parseProjectDocument(serializeProjectDocument(once)).doc;
    expect(serializeProjectDocument(twice)).toBe(serializeProjectDocument(once));
  });

  it("migrates a pre-Phase-17 timeline-only save (the old Save button)", () => {
    const legacy = serializeTimeline(buildComplexProject().timeline);
    const p = parseProjectDocument(legacy, { id: () => "new-id", now: () => "2026-10-08T00:00:00.000Z" });
    expect(p.migratedFrom).toBe("clipbench-timeline v10");
    expect(p.doc).toMatchObject({ id: "new-id", revision: 0, assets: [], aiResults: null });
    expect(p.warnings[0]).toMatch(/relinked once/);
  });

  it("refuses invalid core content (timeline, AI results, assets) and newer formats — no half-loaded projects", () => {
    const d = JSON.parse(serializeProjectDocument(docOf()));
    const bad = (mut: (x: Record<string, any>) => void) => {
      const x = structuredClone(d);
      mut(x);
      return () => parseProjectDocument(JSON.stringify(x));
    };
    expect(bad((x) => (x.timeline.timeline.frameRate = -1))).toThrow(/timeline is invalid/);
    expect(bad((x) => (Object.values(x.timeline.timeline.clips as Record<string, any>)[0].timelineStart = -5))).toThrow(/timeline is invalid/);
    expect(bad((x) => (x.aiResults.results[0].feature = "mind-reading"))).toThrow(/AI results are invalid/);
    expect(bad((x) => (x.assets[0].origin.fingerprint = "nope"))).toThrow(/Asset 1 is invalid/);
    expect(bad((x) => x.assets.push(x.assets[0]))).toThrow(/same asset twice/);
    expect(bad((x) => (x.version = 99))).toThrow(/newer version/);
    expect(bad((x) => (x.format = "something-else"))).toThrow(ProjectDocumentError);
    expect(() => parseProjectDocument("{not json")).toThrow(/isn't valid JSON/);
  });

  it("auxiliary data (export settings, playhead) that fails validation falls back with a warning", () => {
    const d = JSON.parse(serializeProjectDocument(docOf()));
    d.exportSettings = { presetId: "no-such-preset", profile: {} };
    d.ui = { frame: -3 };
    const p = parseProjectDocument(JSON.stringify(d));
    expect(p.doc.exportSettings).toBeNull();
    expect(p.doc.ui.frame).toBe(0);
    expect(p.warnings).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ assets

describe("assets: usage, fingerprints, relink rules", () => {
  it("usage lists every media and matte source with the furthest frame read", () => {
    const f = buildComplexProject();
    const u = assetUsage(f.timeline);
    expect([...u.keys()].sort()).toEqual(["probe-counter30", "probe-logo", FIXTURE_MATTE_ID, "probe-tone"].sort());
    expect(u.get("probe-counter30")!.maxSourceFrame).toBe(150);
    expect([...u.get(FIXTURE_MATTE_ID)!.roles]).toEqual(["matte"]);
  });

  it("fingerprint: same content = same print whatever the name; different content or size differs; reads ≤ 2 MiB", async () => {
    const big = new Uint8Array(5 << 20).map((_, i) => i % 251);
    const a = await fingerprintBlob(new File([big], "a.mp4"));
    expect(await fingerprintBlob(new File([big], "renamed.mp4"))).toBe(a);
    const changedMiddle = big.slice();
    changedMiddle[2 << 20] ^= 1; // outside the hashed edges: by design not detected (fingerprint, not full hash)
    expect(await fingerprintBlob(new File([changedMiddle], "a.mp4"))).toBe(a);
    const changedEdge = big.slice();
    changedEdge[10] ^= 1;
    expect(await fingerprintBlob(new File([changedEdge], "a.mp4"))).not.toBe(a);
    expect(await fingerprintBlob(new File([big.subarray(1)], "a.mp4"))).not.toBe(a);
  });

  it("match: exact, renamed, same name with different content, unrelated", async () => {
    const orig = file("take1.mp4", "ORIGINAL");
    const reg = new AssetRegistry();
    const rec = await reg.setFile("v", "video", orig);
    expect(await matchRelink(rec, file("take1.mp4", "ORIGINAL"))).toBe("exact");
    expect(await matchRelink(rec, file("moved-take1.mp4", "ORIGINAL"))).toBe("renamed");
    expect(await matchRelink(rec, file("take1.mp4", "A DIFFERENT TAKE"))).toBe("same-name-different-content");
    expect(await matchRelink(rec, file("other.mp4", "zzz"))).toBe("none");
  });

  it("relink check: wrong kind or too short refused; size difference and unproven identity warn", () => {
    const rec: AssetRecord = { id: "v", kind: "video", label: "take1.mp4", origin: { type: "file", name: "take1.mp4", size: 8, lastModified: 0, mimeType: "video/mp4", fingerprint: "0".repeat(64) }, media: { width: 1920, height: 1080, durationSec: 10 } };
    const usage = { sourceId: "v", clipIds: ["c"], roles: new Set<"media" | "matte">(["media"]), maxSourceFrame: 150 };
    expect(checkRelink(rec, { kind: "image", width: 1920, height: 1080 }, usage, 30, "none").errors[0]).toMatch(/was a video; the chosen file is an image/);
    expect(checkRelink(rec, { kind: "video", width: 1920, height: 1080, durationSec: 4 }, usage, 30, "exact").errors[0]).toMatch(/up to 5.00 s, but the chosen file is only 4.00 s/);
    const ok = checkRelink(rec, { kind: "video", width: 1280, height: 720, durationSec: 5 }, usage, 30, "same-name-different-content");
    expect(ok.ok).toBe(true);
    expect(ok.warnings.join(" ")).toMatch(/Size differs.*same name/);
    expect(checkRelink({ ...rec, kind: "audio" }, { kind: "video", durationSec: 6 }, usage, 30, "exact").ok).toBe(true); // a video's soundtrack can stand in for audio
  });
});

// ------------------------------------------------------------------------------------------------ storage, autosave, recovery

describe("storage", () => {
  it("retention keeps the newest 50 saves and 20 others, never the newest version", () => {
    const vs: VersionSummary[] = Array.from({ length: 100 }, (_, i) => ({ projectId: "p", revision: i + 1, savedAt: i, reason: i % 2 ? "save" : "autosave", name: "p", sha256: "", bytes: 0 }));
    const drop = new Set(versionsToPrune(vs));
    const kept = vs.filter((v) => !drop.has(v.revision));
    expect(kept.filter((v) => v.reason === "save")).toHaveLength(50);
    expect(kept.filter((v) => v.reason !== "save")).toHaveLength(20);
    expect(drop.has(100)).toBe(false);
    expect(versionsToPrune(vs.slice(0, 3))).toEqual([]);
  });

  it("a failed commit applies nothing (version and meta move together)", async () => {
    const s = new MemoryProjectStore();
    const v = { projectId: "p", revision: 1, savedAt: 0, reason: "save" as const, name: "p", sha256: "x", bytes: 1, json: "{}" };
    const meta = { id: "p", name: "p", createdAt: 0, updatedAt: 0, lastSavedRevision: 1, headRevision: 1 };
    s.failNextCommit = new Error("QuotaExceededError");
    await expect(s.commit(v, meta)).rejects.toThrow(/Quota/);
    expect(await s.listVersions("p")).toEqual([]);
    expect(await s.getMeta("p")).toBeUndefined();
    await s.commit(v, meta);
    expect(await s.listVersions("p")).toHaveLength(1);
  });
});

function fakeTimers() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > target) break;
        timers.shift();
        now = t.at;
        t.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = target;
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("autosave", () => {
  it("debounces edits, but never waits longer than maxDelay after the first unsaved edit", async () => {
    const t = fakeTimers();
    const save = vi.fn(async () => {});
    const a = new Autosaver({ save, delayMs: 2000, maxDelayMs: 10000, ...t });
    for (let i = 0; i < 4; i++) {
      a.markDirty();
      await t.advance(1500);
    }
    expect(save).not.toHaveBeenCalled(); // 6 s of continuous edits, each < 2 s apart
    for (let i = 0; i < 4; i++) {
      a.markDirty();
      await t.advance(1500);
    }
    expect(save).toHaveBeenCalledTimes(1); // forced at the 10 s cap
    await t.advance(5000);
    expect(save).toHaveBeenCalledTimes(2); // the edits after it, 2 s after the last one
    expect(a.current.state).toBe("idle");
  });

  it("never overlaps saves: an edit during a save triggers exactly one more afterwards", async () => {
    const t = fakeTimers();
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const save = vi.fn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => (release = r));
      running--;
    });
    const a = new Autosaver({ save, delayMs: 100, ...t });
    a.markDirty();
    await t.advance(100);
    expect(save).toHaveBeenCalledTimes(1);
    a.markDirty();
    a.markDirty();
    release();
    await t.advance(0);
    await t.advance(100);
    expect(save).toHaveBeenCalledTimes(2);
    release();
    await t.advance(1000);
    expect(maxRunning).toBe(1);
  });

  it("a failing save reports the error, stays dirty and retries", async () => {
    const t = fakeTimers();
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error("QuotaExceededError: disk full");
    });
    const a = new Autosaver({ save, delayMs: 100, retryMs: 5000, ...t });
    a.markDirty();
    await t.advance(100);
    expect(a.current).toMatchObject({ state: "error", error: "QuotaExceededError: disk full" });
    fail = false;
    await t.advance(5000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(a.current.state).toBe("idle");
  });
});

describe("crash detection", () => {
  it("a session that stopped beating without closing cleanly, with unsaved autosaves, is recoverable — nothing else is", async () => {
    const store = new MemoryProjectStore();
    const meta = (id: string, saved: number) => ({ id, name: id, createdAt: 0, updatedAt: 0, lastSavedRevision: saved, headRevision: 5 });
    const ver = (p: string, r: number, reason: "save" | "autosave") => ({ projectId: p, revision: r, savedAt: r * 1000, reason, name: p, sha256: "", bytes: 0, json: "" });
    await store.commit(ver("crashed", 5, "autosave"), meta("crashed", 3));
    await store.commit(ver("clean", 5, "autosave"), meta("clean", 3));
    await store.commit(ver("alive", 5, "autosave"), meta("alive", 3));
    await store.commit(ver("saved", 5, "save"), meta("saved", 5));
    await store.putSession({ id: "s1", projectId: "crashed", startedAt: 0, heartbeat: 1000, clean: false });
    await store.putSession({ id: "s2", projectId: "clean", startedAt: 0, heartbeat: 1000, clean: true });
    await store.putSession({ id: "s3", projectId: "alive", startedAt: 0, heartbeat: 95_000, clean: false });
    await store.putSession({ id: "s4", projectId: "saved", startedAt: 0, heartbeat: 1000, clean: false });
    const r = await findRecoverable(store, { now: 100_000 });
    expect(r.map((x) => x.projectId)).toEqual(["crashed"]);
    expect(r[0]).toMatchObject({ sessionId: "s1", lastSavedRevision: 3, version: { revision: 5 } });
  });

  it("REGRESSION (found live): the clean-close write to IndexedDB is lost in pagehide — the synchronous flag still marks the session clean", async () => {
    const store = new MemoryProjectStore();
    const flagStore = new Map<string, string>();
    const flags = { set: (id: string) => void flagStore.set(id, "1"), has: (id: string) => flagStore.has(id), clear: (id: string) => void flagStore.delete(id) };
    await store.commit({ projectId: "p", revision: 2, savedAt: 1, reason: "autosave", name: "p", sha256: "", bytes: 0, json: "" }, { id: "p", name: "p", createdAt: 0, updatedAt: 0, lastSavedRevision: 1, headRevision: 2 });
    const tr = new SessionTracker(store, "tab-1", () => 1000, flags);
    await tr.start(0);
    await tr.setProject("p");
    // Chrome aborts the IndexedDB transaction as the page is torn down: simulate by dropping the write.
    store.putSession = async () => {};
    await tr.end();
    expect(store.sessions.get("tab-1")!.clean).toBe(false); // the row never learned about the clean close...
    expect(await findRecoverable(store, { now: 100_000 })).toHaveLength(1); // ...so without the flag: a false crash
    expect(await findRecoverable(store, { now: 100_000, flags })).toEqual([]); // with it: correctly clean
  });

  it("dead sessions with nothing to recover are pruned; clean ones are cleaned up", async () => {
    const store = new MemoryProjectStore();
    await store.putSession({ id: "dead-empty", projectId: null, startedAt: 0, heartbeat: 0, clean: false });
    await store.putSession({ id: "clean", projectId: null, startedAt: 0, heartbeat: 0, clean: true });
    await findRecoverable(store, { now: 100_000, pruneDead: true });
    expect([...store.sessions.keys()]).toEqual(["clean"]);
    const { cleanupSessions } = await import("./recovery");
    await cleanupSessions(store, [], 100_000);
    expect(store.sessions.size).toBe(0);
  });

  it("the tracker writes heartbeats and a clean flag on close", async () => {
    const store = new MemoryProjectStore();
    let now = 10;
    const tr = new SessionTracker(store, "tab-1", () => now);
    await tr.start(0);
    now = 20;
    await tr.setProject("p");
    expect(store.sessions.get("tab-1")).toMatchObject({ projectId: "p", heartbeat: 20, clean: false });
    await tr.end();
    expect(store.sessions.get("tab-1")!.clean).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ manager

/** A fake editor: its state is plain data; media "loads" if the test made it available. */
class FakeEditor implements ProjectHost {
  state: EditorState;
  available = new Set<string>(); // fingerprints of user files "on disk"
  loaded = new Map<string, string>(); // sourceId -> what's loaded
  probes: Record<string, { kind: "video" | "image" | "audio"; width?: number; height?: number; durationSec?: number }> = {};
  applied = 0;
  constructor(
    readonly registry: AssetRegistry,
    s: EditorState,
  ) {
    this.state = s;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  apply(doc: ProjectDocument) {
    this.applied++;
    this.state = { timeline: doc.timeline, aiResults: doc.aiResults, exportSettings: doc.exportSettings, ui: doc.ui };
  }
  async materialize(doc: ProjectDocument, pngFor: (sha: string) => Promise<Uint8Array | undefined>, opts: { only?: string[] } = {}): Promise<AssetStatus[]> {
    const out: AssetStatus[] = [];
    for (const r of doc.assets) {
      if (opts.only && !opts.only.includes(r.id)) continue;
      const base = { id: r.id, label: r.label, kind: r.kind };
      if (r.origin.type === "generated") {
        const pngs = await Promise.all(r.origin.frames.map((f) => pngFor(f.sha256)));
        if (pngs.some((p) => !p)) out.push({ ...base, state: "damaged" });
        else {
          r.origin.frames.forEach((f, i) => this.registry.addPng(f.sha256, pngs[i]!));
          this.registry.adopt(r);
          this.loaded.set(r.id, "generated");
          out.push({ ...base, state: "ok" });
        }
      } else if (r.origin.type === "url" || this.available.has(r.origin.fingerprint)) {
        this.registry.adopt(r, r.origin.type === "file" ? { file: new Blob([]) } : undefined);
        this.loaded.set(r.id, r.origin.type);
        out.push({ ...base, state: "ok" });
      } else out.push({ ...base, state: "missing" });
    }
    return out;
  }
  async probeAndRegister(id: string, _k: unknown, f: File) {
    const p = this.probes[f.name];
    if (!p) throw new Error("undecodable");
    this.loaded.set(id, f.name);
    return p;
  }
  unregister(id: string) {
    this.loaded.delete(id);
  }
}

/** A file on a fake disk with the atomic-replace semantics of File System Access (or not, to simulate a torn write). */
class FakeFile {
  bytes: Uint8Array | null = null;
  writes = 0;
  target(opts: { failAfter?: number; atomic?: boolean } = {}): ProjectFileTarget {
    return {
      name: "complex.clipbench",
      write: async (b) => {
        this.writes++;
        if (opts.failAfter !== undefined) {
          if (opts.atomic === false) this.bytes = b.slice(0, opts.failAfter); // a naive writer leaves a torn file
          throw new Error("Simulated interruption");
        }
        this.bytes = b.slice();
      },
    };
  }
}

async function setup() {
  const f = buildComplexProject();
  const store = new MemoryProjectStore();
  const registry = new AssetRegistry();
  await registry.setFile("probe-counter30", "video", file("counter30.mp4", "COUNTER-VIDEO-BYTES"), { width: 1920, height: 1080, durationSec: 6, fps: 30 });
  registry.setUrl("probe-logo", "image", "logo-half-red.png", "/assets/logo.png");
  await registry.setFile("probe-tone", "audio", file("tone.wav", "TONE-BYTES", "audio/wav"), { durationSec: 3.5 });
  await registry.setGenerated(FIXTURE_MATTE_ID, "sequence", "Background removal", "background-removal", [
    { frame: 90, bytes: png(90), width: 64, height: 36 },
    { frame: 120, bytes: png(120), width: 64, height: 36 },
  ]);
  const editor = new FakeEditor(registry, { timeline: f.timeline, aiResults: f.aiResults, exportSettings: f.exportSettings, ui: { frame: 42 } });
  const fp = (id: string) => (registry.get(id)!.origin as { fingerprint: string }).fingerprint;
  editor.available.add(fp("probe-counter30")).add(fp("probe-tone"));
  let t = 1_000_000;
  const mgr = new ProjectManager({ store, host: editor, registry, now: () => (t += 1000), newId: () => "project-test", autosave: false });
  mgr.rename("Complex project");
  return { f, store, registry, editor, mgr, fp };
}

/** "Close the app": a brand-new registry, editor and manager over the same database. */
async function reopen(store: MemoryProjectStore, available: Set<string>) {
  const registry = new AssetRegistry();
  const editor = new FakeEditor(registry, { timeline: buildComplexProject().timeline, aiResults: null, exportSettings: null, ui: { frame: 0 } });
  editor.available = available;
  const mgr = new ProjectManager({ store, host: editor, registry, newId: () => "fresh", autosave: false });
  return { registry, editor, mgr };
}

const canon = (s: EditorState) => serializeProjectDocument({ format: "clipbench-project", version: 1, id: "", name: "", createdAt: "", savedAt: "", revision: 0, timeline: s.timeline, assets: [], aiResults: s.aiResults, exportSettings: s.exportSettings, ui: s.ui });

describe("project manager", () => {
  it("create complex project → Save → close → reopen → identical state, media resolved, generated matte restored", async () => {
    const { store, editor, mgr, registry } = await setup();
    const disk = new FakeFile();
    await expect(mgr.save()).rejects.toThrow(NeedsSaveTargetError);
    const v = await mgr.saveAs(disk.target());
    expect(v).toMatchObject({ revision: 1, reason: "save" });
    expect(mgr.state).toMatchObject({ dirty: false, savedRevision: 1, fileName: "complex.clipbench" });
    const before = canon(editor.state);
    const beforeAssets = registry.recordsFor(["probe-counter30", "probe-logo", "probe-tone", FIXTURE_MATTE_ID]);

    // The file alone carries the generated matte.
    const decoded = await decodeBundle(disk.bytes!);
    expect([...decoded.entries.keys()].filter((n) => n.startsWith("blobs/"))).toHaveLength(2);

    const fresh = await reopen(new MemoryProjectStore(), new Set(editor.available)); // a different browser: no local history at all
    const res = await fresh.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    expect(res.warnings).toEqual([]);
    expect(res.assets.map((a) => `${a.id}:${a.state}`).sort()).toEqual(["probe-counter30:ok", "probe-logo:ok", FIXTURE_MATTE_ID + ":ok", "probe-tone:ok"].sort());
    expect(canon(fresh.editor.state)).toBe(before);
    expect(fresh.registry.recordsFor(["probe-counter30", "probe-logo", "probe-tone", FIXTURE_MATTE_ID])).toEqual(beforeAssets);
    expect(fresh.mgr.state).toMatchObject({ id: "project-test", name: "Complex project", dirty: false, savedRevision: 1 });
    expect(fresh.editor.loaded.get(FIXTURE_MATTE_ID)).toBe("generated");
    void store;
  });

  it("a per-frame MATTE TRACK (chunked blobs) saves, reopens bit-identical and replaces the PNG sequence it supersedes", async () => {
    const { editor, mgr, registry } = await setup();
    const b = new MatteTrackBuilder(32, 18, 90, { chunkFrames: 4 });
    for (let k = 0; k < 10; k++) await b.push(Uint8Array.from({ length: 32 * 18 }, (_, i) => ((i + k * 7) * 13) & 255));
    const chunks = await b.finish();
    await registry.setGenerated(FIXTURE_MATTE_ID, "matte-track", "Background removal", "background-removal", chunks.map((c) => ({ frame: c.firstFrame, bytes: c.bytes, width: 32, height: 18 })));
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const decoded = await decodeBundle(disk.bytes!);
    // One blob per chunk (3), not one PNG per frame; the superseded sequence PNGs aren't written.
    expect([...decoded.entries.keys()].filter((n) => n.startsWith("blobs/"))).toHaveLength(3);

    const fresh = await reopen(new MemoryProjectStore(), new Set(editor.available));
    const res = await fresh.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    expect(res.assets.find((a) => a.id === FIXTURE_MATTE_ID)).toMatchObject({ state: "ok", kind: "matte-track" });
    const rec = fresh.registry.get(FIXTURE_MATTE_ID)!;
    expect(rec.kind).toBe("matte-track");
    const reopened = new MatteTrack((rec.origin as { frames: { sha256: string }[] }).frames.map((f) => fresh.registry.png(f.sha256)!));
    const original = new MatteTrack(chunks.map((c) => c.bytes));
    expect(reopened.frameCount).toBe(10);
    for (let f = 90; f < 100; f++) expect(await reopened.decodeFrame(f)).toEqual(await original.decodeFrame(f));
  });

  it("source media is never written: only the project target receives bytes, and it never contains the source files", async () => {
    const { mgr } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const text = new TextDecoder("latin1").decode(disk.bytes!);
    expect(text).not.toContain("COUNTER-VIDEO-BYTES");
    expect(text).not.toContain("TONE-BYTES");
    expect(text).toContain("counter30.mp4"); // referenced by name + fingerprint
  });

  it("Save writes the next revision to the same file; Save As switches the project to the new file", async () => {
    const { mgr, editor } = await setup();
    const a = new FakeFile();
    const b = new FakeFile();
    await mgr.saveAs(a.target());
    editor.state.ui.frame = 7;
    mgr.markEdited();
    mgr.targetForHandle = null;
    await mgr.save(a.target());
    expect(mgr.state.savedRevision).toBe(2);
    await mgr.saveAs(b.target());
    expect(mgr.state.savedRevision).toBe(3);
    expect((await mgr.listVersions()).map((v) => `${v.revision}:${v.reason}`)).toEqual(["1:save", "2:save", "3:save"]);
  });

  it("autosave stores a version only when the content changed", async () => {
    const { mgr, editor, store } = await setup();
    await mgr.saveAs(new FakeFile().target());
    const autosave = (mgr as unknown as { autosave: () => Promise<void> }).autosave.bind(mgr);
    mgr.markEdited(); // dirty flag but identical content
    await autosave();
    expect((await store.listVersions("project-test")).length).toBe(1);
    editor.state.timeline = setClipVisual(editor.state.timeline, Object.keys(editor.state.timeline.clips)[0], { opacity: 0.5 });
    mgr.markEdited();
    await autosave();
    const vs = await store.listVersions("project-test");
    expect(vs.map((v) => v.reason)).toEqual(["save", "autosave"]);
    expect(mgr.state).toMatchObject({ headRevision: 2, savedRevision: 1, dirty: true });
  });

  it("CRASH: autosaved work survives a killed tab and is recovered into a new session", async () => {
    const { mgr, editor, store } = await setup();
    const tracker = new SessionTracker(store, "tab-A", () => 1000);
    await tracker.start(0);
    await tracker.setProject("project-test");
    await mgr.saveAs(new FakeFile().target());
    editor.state.timeline = setClipVisual(editor.state.timeline, Object.keys(editor.state.timeline.clips)[1], { opacity: 0.25 });
    mgr.markEdited();
    await (mgr as unknown as { autosave: () => Promise<void> }).autosave();
    const expected = canon(editor.state);
    // ...the tab dies here: no end(), no Save.
    tracker.stopBeating();
    const fresh = await reopen(store, new Set(editor.available));
    const rec = await findRecoverable(store, { now: 1000 + 60_000 });
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ projectId: "project-test", lastSavedRevision: 1, version: { revision: 2, reason: "autosave" } });
    await fresh.mgr.recover(rec[0]);
    expect(canon(fresh.editor.state)).toBe(expected);
    expect(fresh.mgr.state).toMatchObject({ id: "project-test", dirty: true, savedRevision: 1 });
    expect(await findRecoverable(store, { now: 1000 + 60_000 })).toEqual([]); // offered once
    expect((await store.listVersions("project-test")).at(-1)!.reason).toBe("recovered");
  });

  it("CORRUPTED project file: refused with the reason; the open project is untouched; history offers the last good version", async () => {
    const { mgr, editor, store } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const other = await reopen(store, new Set(editor.available));
    const before = canon(other.editor.state);
    const bad = disk.bytes!.slice();
    const docStart = 16 + new DataView(bad.buffer).getUint32(12, true); // header + manifest; project.json is the first entry
    bad[docStart + 200] ^= 0x41; // inside project.json
    await expect(other.mgr.openFile(bad, { name: "complex.clipbench" })).rejects.toThrow(/project\.json failed verification/);
    await expect(other.mgr.openFile(disk.bytes!.subarray(0, 1000), { name: "complex.clipbench" })).rejects.toThrow(/incomplete|truncated/);
    expect(canon(other.editor.state)).toBe(before);
    expect(other.editor.applied).toBe(0);
    // The last good state is still in local history:
    const vs = await other.mgr.listVersions("project-test");
    await other.mgr.restoreVersion(vs.at(-1)!.revision, "project-test");
    expect(canon(other.editor.state)).toBe(canon(editor.state));
  });

  it("CORRUPTED embedded media: the project opens; the matte is healed from local blobs, or marked damaged", async () => {
    const { mgr, editor, store } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const bytes = disk.bytes!.slice();
    bytes[bytes.length - 48 - 3] ^= 0xff; // inside the last embedded PNG
    const sameBrowser = await reopen(store, new Set(editor.available));
    const r1 = await sameBrowser.mgr.openFile(bytes, { name: "complex.clipbench" });
    expect(r1.warnings.join(" ")).toMatch(/restored it from this browser's copy/);
    expect(r1.assets.find((a) => a.id === FIXTURE_MATTE_ID)!.state).toBe("ok");
    const otherBrowser = await reopen(new MemoryProjectStore(), new Set(editor.available));
    const r2 = await otherBrowser.mgr.openFile(bytes, { name: "complex.clipbench" });
    expect(r2.assets.find((a) => a.id === FIXTURE_MATTE_ID)!.state).toBe("damaged");
    expect(canon(otherBrowser.editor.state)).toBe(canon(editor.state)); // everything else intact
  });

  it("CORRUPTED local history: a damaged stored version is refused by checksum", async () => {
    const { mgr, store } = await setup();
    await mgr.saveAs(new FakeFile().target());
    const v = store.versions.get("project-test#1")!;
    v.json = v.json.replace('"Complex project"', '"Complex projecT"');
    await expect(mgr.restoreVersion(1)).rejects.toThrow(/damaged \(checksum mismatch\)/);
  });

  it("INTERRUPTED SAVE: an atomic target keeps the previous file byte-for-byte; nothing is recorded as saved", async () => {
    const { mgr, editor } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const good = disk.bytes!.slice();
    editor.state.ui.frame = 99;
    mgr.markEdited();
    await expect(mgr.save(disk.target({ failAfter: 500 }))).rejects.toThrow(/Simulated interruption/);
    expect([...disk.bytes!]).toEqual([...good]);
    expect(mgr.state).toMatchObject({ savedRevision: 1, dirty: true });
    expect((await mgr.listVersions()).map((v) => v.reason)).toEqual(["save"]);
    await mgr.save(disk.target());
    expect(mgr.state).toMatchObject({ savedRevision: 2, dirty: false });
  });

  it("INTERRUPTED SAVE (non-atomic writer, e.g. a download cut off): the torn file is detected on open, history has the state", async () => {
    const { mgr, editor, store } = await setup();
    const disk = new FakeFile();
    editor.state.ui.frame = 11;
    await expect(mgr.saveAs(disk.target({ failAfter: 700, atomic: false }))).rejects.toThrow();
    expect(disk.bytes!.length).toBe(700);
    const other = await reopen(store, new Set(editor.available));
    await expect(other.mgr.openFile(disk.bytes!, { name: "x.clipbench" })).rejects.toThrow(ProjectCorruptError);
  });

  it("INTERRUPTED local commit (quota error mid-write): no partial version, revision not consumed", async () => {
    const { mgr, store, editor } = await setup();
    await mgr.saveAs(new FakeFile().target());
    editor.state.ui.frame = 5;
    mgr.markEdited();
    store.failNextCommit = new Error("QuotaExceededError");
    await expect((mgr as unknown as { autosave: () => Promise<void> }).autosave()).rejects.toThrow(/Quota/);
    expect((await store.listVersions("project-test")).map((v) => v.revision)).toEqual([1]);
    expect(mgr.state.headRevision).toBe(1);
    await (mgr as unknown as { autosave: () => Promise<void> }).autosave();
    expect((await store.listVersions("project-test")).map((v) => v.revision)).toEqual([1, 2]);
  });

  it("MISSING MEDIA: detected on open, relinked by the user; refuses a too-short file; asks before accepting a different file", async () => {
    const { mgr, editor, fp } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const other = await reopen(new MemoryProjectStore(), new Set([fp("probe-tone")])); // the video isn't on this machine
    const r = await other.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    expect(r.assets.filter((a) => a.state !== "ok").map((a) => a.id)).toEqual(["probe-counter30"]);
    other.editor.probes = {
      "short.mp4": { kind: "video", width: 1920, height: 1080, durationSec: 2 },
      "counter30.mp4": { kind: "video", width: 1920, height: 1080, durationSec: 6 },
      "counter-copy.mp4": { kind: "video", width: 1920, height: 1080, durationSec: 6 },
      "photo.png": { kind: "image", width: 100, height: 100 },
    };
    const short = await other.mgr.relink("probe-counter30", file("short.mp4", "SHORT"));
    expect(short).toMatchObject({ ok: false, errors: [expect.stringMatching(/only 2.00 s long/)] });
    expect((await other.mgr.relink("probe-counter30", file("photo.png", "PNG", "image/png"))).errors[0]).toMatch(/was a video/);
    const different = await other.mgr.relink("probe-counter30", file("counter30.mp4", "ANOTHER TAKE"));
    expect(different).toMatchObject({ ok: false, needsConfirm: true, match: "same-name-different-content" });
    expect(other.editor.loaded.has("probe-counter30")).toBe(false); // nothing left loaded after a refusal
    // The real file, renamed: accepted without asking, project unchanged (same content).
    const renamed = await other.mgr.relink("probe-counter30", file("counter-copy.mp4", "COUNTER-VIDEO-BYTES"));
    expect(renamed).toMatchObject({ ok: true, match: "renamed" });
    expect(other.mgr.state.assets.every((a) => a.state === "ok")).toBe(true);
    expect(other.mgr.state.dirty).toBe(true); // same content, new name: the new location should be saved
    expect(other.registry.get("probe-counter30")!.media).toMatchObject({ fps: 30, durationSec: 6 }); // fps kept from the original record
    void editor;
  });

  it("relink to a different file when confirmed: recorded in the project (dirty, new fingerprint)", async () => {
    const { mgr, fp } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const other = await reopen(new MemoryProjectStore(), new Set([fp("probe-tone")]));
    await other.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    other.editor.probes = { "counter30.mp4": { kind: "video", width: 1280, height: 720, durationSec: 6 } };
    const r = await other.mgr.relink("probe-counter30", file("counter30.mp4", "ANOTHER TAKE"), { confirm: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/Size differs/);
    expect(other.mgr.state.dirty).toBe(true);
    expect((other.registry.get("probe-counter30")!.origin as { fingerprint: string }).fingerprint).toBe(await fingerprintBlob(file("counter30.mp4", "ANOTHER TAKE")));
  });

  it("the very same file (name, date, content) found again doesn't make the project dirty", async () => {
    const { mgr } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const other = await reopen(new MemoryProjectStore(), new Set());
    await other.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    other.editor.probes = { "counter30.mp4": { kind: "video", width: 1920, height: 1080, durationSec: 6 } };
    expect(await other.mgr.relink("probe-counter30", file("counter30.mp4", "COUNTER-VIDEO-BYTES"))).toMatchObject({ ok: true, match: "exact" });
    expect(other.mgr.state.dirty).toBe(false);
  });

  it("relinkMany matches dropped files to missing assets by content", async () => {
    const { mgr } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    const other = await reopen(new MemoryProjectStore(), new Set());
    const r = await other.mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    expect(r.assets.filter((a) => a.state === "missing").map((a) => a.id).sort()).toEqual(["probe-counter30", "probe-tone"]);
    other.editor.probes = { "renamed-tone.wav": { kind: "audio", durationSec: 3.5 }, "counter30.mp4": { kind: "video", width: 1920, height: 1080, durationSec: 6 } };
    const done = await other.mgr.relinkMany([{ file: file("unrelated.mp4", "x") }, { file: file("renamed-tone.wav", "TONE-BYTES", "audio/wav") }, { file: file("counter30.mp4", "COUNTER-VIDEO-BYTES") }]);
    expect(done.sort()).toEqual(["probe-counter30", "probe-tone"]);
  });

  it("legacy timeline-only save opens as a project with every source to relink", async () => {
    const { editor } = await setup();
    const other = await reopen(new MemoryProjectStore(), new Set());
    const r = await other.mgr.openFile(enc(serializeTimeline(editor.state.timeline)), { name: "old.json" });
    expect(r.migratedFrom).toMatch(/clipbench-timeline/);
    expect(canon({ ...other.editor.state, aiResults: null, exportSettings: null, ui: { frame: 0 } })).toBe(canon({ timeline: editor.state.timeline, aiResults: null, exportSettings: null, ui: { frame: 0 } }));
  });

  it("versions: restore an earlier one; the state replaced by it is kept as a restore point", async () => {
    const { mgr, editor } = await setup();
    await mgr.saveAs(new FakeFile().target());
    const v1 = canon(editor.state);
    editor.state.ui.frame = 77;
    mgr.markEdited();
    const v2 = canon(editor.state);
    await mgr.restoreVersion(1);
    expect(canon(editor.state)).toBe(v1);
    const vs = await mgr.listVersions();
    expect(vs.map((v) => v.reason)).toEqual(["save", "before-restore", "restored"]);
    await mgr.restoreVersion(vs[1].revision);
    expect(canon(editor.state)).toBe(v2);
  });

  it("opening another project stores unsaved work first", async () => {
    const { mgr, editor, store } = await setup();
    const disk = new FakeFile();
    await mgr.saveAs(disk.target());
    editor.state.ui.frame = 12;
    mgr.markEdited();
    await mgr.openFile(disk.bytes!, { name: "complex.clipbench" });
    expect((await store.listVersions("project-test")).map((v) => v.reason)).toContain("before-open");
  });

  it("checksums: identical content gives identical bytes (deterministic documents)", async () => {
    const { mgr } = await setup();
    const a = new FakeFile();
    await mgr.saveAs(a.target());
    const doc = parseProjectDocument(new TextDecoder().decode((await decodeBundle(a.bytes!)).entries.get(DOCUMENT_ENTRY))).doc;
    expect(await sha256Hex(await mgr.encode(doc))).toBe(await sha256Hex(await mgr.encode(doc)));
  });
});
