# Phase 17 — Project Persistence & Recovery: Architecture

A project can be saved to a file, reopened anywhere, autosaved continuously, recovered after a crash, rolled back to earlier versions, and relinked when its media moves. Source media is never written to.

```
                       ┌──────────── editor (TimelineEngine, frame provider, audio store, AI store, export panel)
                       │  snapshot() / apply(doc)                 ▲ media loaded / unloaded
                       ▼                                          │
   ProjectManager ─── ProjectDocument ──┬── bundle.ts ──▶ .clipbench file      (Save / Save As / Open)
   (manager.ts)      (document.ts)      │                 via ProjectFileTarget: atomic, never onto source media
     │  autosave.ts                      └── storage.ts ──▶ IndexedDB           (autosave, versions, blobs,
     │  recovery.ts ── sessions + heartbeats + clean flags                       sessions, media handles)
     └─ AssetRegistry + media host ── where each sourceId's media comes from; resolve / detect missing / relink
```

## 1. Files (`src/lib/project/`)

| File | Role |
|---|---|
| `document.ts` | `ProjectDocument`: schema, validation, migration from older saves |
| `bundle.ts` | the `.clipbench` container: manifest, per-entry and whole-file SHA-256, truncation detection |
| `assets.ts` | `AssetRecord` (file / url / generated), content fingerprint, asset usage, relink match and check |
| `asset-registry.ts` | the session's record of where each source came from, plus PNG bytes of generated media |
| `media-host.ts` | browser: resolves records back into decoded media; reports missing, damaged, needs-permission |
| `storage.ts` | `ProjectStore`: IndexedDB (app) and memory (tests); atomic commit; retention policy |
| `autosave.ts` | debounced, capped, non-overlapping autosave with error reporting and retry |
| `recovery.ts` | session heartbeat, clean-close flags, crash detection, recovery list |
| `manager.ts` | `ProjectManager`: Save, Save As, Open, versions, restore, recover, relink, missing media |
| `file-target.ts` | browser: atomic File System Access writes, the source-media guard, pickers, download fallback |
| `fixture.ts`, `persistence-harness.ts` | test fixtures (not used by the app) |

UI lives in `components/tool/video/composition/ProjectFileBar.tsx`: the `useProjectPersistence` hook plus the bar. It shows Save / Save As / Open / Versions, the name, status, the recovery banner and the missing-media panel. It is wired into `CompositionPlaygroundPanel.tsx`.

## 2. What a project contains (`document.ts`)

| Field | Content |
|---|---|
| `timeline` | the `TimelineModel` through the existing strict serializer (`timeline/serialize.ts`, format v10). Covers: <ul><li>clips, text, graphics (shapes and SVG)</li><li>transforms, crops, keyframes, effects</li><li>transitions, per-clip audio, captions with word timings</li><li>masks, matte references, guides</li></ul> |
| `assets` | one `AssetRecord` per source the timeline uses (§4) |
| `aiResults` | the AI result store (analyses and the user's curation: accepted/rejected items, edited ranges) |
| `exportSettings` | the export panel's preset, profile and "modified" flag |
| `ui` | playhead |
| `id`, `name`, `createdAt`, `savedAt`, `revision` | identity; `revision` increases with every persisted state |

**Validation is strict for core content.** The timeline goes through `deserializeTimeline`, which checks:
- structure and links;
- non-overlap;
- every visual;
- animation paths against the clip's real effects and masks;
- transition placement.

AI results go through the AI store's loader. Asset records are checked field by field. Any failure refuses the **whole** document: a project never loads half-valid. Auxiliary data (export settings, playhead) that fails validation falls back to defaults with a warning.

**Normalization is idempotent.** Loading fills every implicit default, such as full text styles and caption track settings. A second save→load is byte-identical (tested).

**Migration:** a bare `clipbench-timeline` JSON (the pre-Phase-17 Save button) opens as a project with no asset records. Its media is resolved if already open in the session, otherwise listed for relinking. A document from a *newer* format version is refused with that reason.

## 3. The `.clipbench` file (`bundle.ts`, `file-target.ts`)

```
"CLIPBNDL" | u32 version | u32 manifestLength | manifest JSON [{name, offset, length, sha256}]
entries…   (project.json, then blobs/<sha256>.png for each generated frame)
"CLIPEND!" | u64 totalLength | SHA-256 of everything before the trailer
```

Decoding checks, in order: signature → trailer present → declared length = actual length → table of contents → each entry's hash → whole-file hash. Every failure is a `ProjectCorruptError` that names the problem:
- "incomplete: its end marker is missing (the save was probably interrupted)";
- "project.json failed verification";
- "wrong signature".

A damaged **generated-media** entry is tolerated. The project still opens and that frame is taken from the browser's blob store if it has a copy (healed, with a warning); otherwise the asset is marked *damaged*. A damaged `project.json` is never tolerated.

**Atomic writes.** Saving uses the File System Access API: `createWritable()` writes to a swap file, `close()` replaces the target in one step, and on any error the stream is `abort()`ed. An interrupted save leaves the previous file byte-for-byte intact. The project's history records the save only after the file write succeeded. Without File System Access, Save As downloads the file, and the browser's download is the atomic step.

**Never overwrite source media.** `handleTarget` refuses, before writing a byte:
1. any file not named `*.clipbench`;
2. any file that `isSameEntry` with a source-media handle the session or database knows, whatever its name.

Source files are only ever read (`getFile`, object URLs). The project file contains no source media bytes: user files are referenced by name, size, date and fingerprint, and only *generated* media (which exists nowhere else) is embedded.

## 4. Assets, missing media and relinking

| Origin | Stored as | Resolved on open from |
|---|---|---|
| `file`: user video, image, audio | name, size, mtime, MIME, **fingerprint** = SHA-256(size + first MiB + last MiB) | <ol><li>the same content already open this session</li><li>a stored **read handle** for that fingerprint (permission permitting, content re-verified)</li><li>otherwise *missing* / *needs permission*</li></ol> |
| `url`: app-served (demo clip) | URL | fetch |
| `generated`: background-removal mattes, AI images, procedural stills | PNG per frame, content-addressed | the project file, else the local blob store, else *damaged* |

- **Read handles.** Media added through the system picker (File System Access) comes with a handle. The project stores it in IndexedDB, keyed by fingerprint, so reopening finds the file automatically. A handle whose permission lapsed shows **Reconnect files**: one click re-requests read permission for all of them. If the file changed on disk, its fingerprint differs and it is reported for relinking, never used silently.
- **Missing media** never blocks opening: the timeline keeps every clip, and the missing-media panel lists each item with its state and reason.
- **Relinking** (`manager.relink`):
  - The candidate is classified as *exact*, *renamed* (same content), *same name with different content*, or *unrelated*.
  - It is decoded, then checked against how the timeline uses it. The wrong kind, or a file shorter than the furthest frame any clip reads, is **refused**, and nothing stays loaded.
  - A file that isn't provably the original requires explicit confirmation ("Use this file anyway"), with size differences shown.
  - **Locate files…** relinks every missing item that one of the chosen files provably is, by content and under any name.
  - Measured media info replaces the old values; fields the probe doesn't measure (fps) are kept.
  - Finding the very same file again leaves the project clean. A new name or date marks it edited, so the new location gets saved.

## 5. Local database (`storage.ts`)

| Store | Content |
|---|---|
| `versions` | `{projectId, revision}` → JSON, SHA-256, reason (`save`, `autosave`, `before-open`, `before-restore`, `restored`, `recovered`) |
| `meta` | name, last saved revision, head revision, project file name and handle |
| `blobs` | generated PNG frames by SHA-256, shared by all versions |
| `sessions` | per open tab: heartbeat, clean flag, project |
| `handles` | source-media read handles by fingerprint |

- `commit(version, meta)` is **one transaction**. An interrupted write (quota error, tab killed, aborted transaction) leaves both untouched, and the revision is not consumed.
- Versions are verified by checksum before use. A damaged version is refused.
- **Retention:** the newest 50 explicit saves plus the newest 20 others per project; the newest version is never pruned.

## 6. Autosave (`autosave.ts`)

- Saves 2 s after the last edit, and at the latest 15 s after the first unsaved one.
- Saves never overlap: an edit made during a save schedules exactly one more.
- A state whose content hash equals the last persisted one is not stored again.
- A failed autosave shows its error ("Autosave failed: …"), keeps the project dirty, and retries after 10 s.
- The tab hiding flushes pending work.

Edits are detected from the editor itself: any change of the engine's timeline (including undo and redo), AI result edits, export-setting changes, renames and relinks. Loading a project is not an edit.

## 7. Crash detection and recovery (`recovery.ts`)

- Each tab writes a session row and refreshes its heartbeat every 5 s.
- A normal close marks the row clean, through a synchronous flag (§10, bug 1).
- On start, a session that is **not clean and hasn't beaten for 15 s** belonged to a tab that died. Sessions still beating are other open tabs and are left alone.
- If the dead tab's project has a stored version newer than its last explicit save, the recovery banner offers it: *"Persistence test wasn't closed properly. Unsaved work from 12:02:57 (version 10) can be recovered."*
- **Recover** opens that version, records it as "recovered" and leaves the project dirty, because it isn't in a file yet.
- **Not now** keeps it in version history.
- A crash seconds before reopening (heartbeat not yet stale) is caught by a second check once the stale window has passed.
- Dead sessions with nothing to recover, and cleanly closed ones, are pruned.
- Closing a tab with unsaved changes shows the browser's "Leave site?" prompt.

## 8. Manager operations (`manager.ts`)

- All operations that read or advance the revision run **serialized**, so autosave and save can't interleave.
- **Save:** builds the next revision, encodes the bundle, writes the file (atomically), *then* commits the version as "save". A project with no file asks for a location (Save As).
- **Save As:** the same, to a new file, which becomes the project's file.
- **Open:**
  1. Verify the file completely.
  2. Store the current project's unsaved work as "before-open".
  3. Store embedded generated media locally.
  4. Resolve all media.
  5. Load the state.
  6. Report the asset statuses.

  If verification fails, nothing in the editor changes.
- **Restore version:** verify the version → store unsaved work as "before-restore" → load → record as "restored". It can therefore itself be undone.
- **Binding:** each manager is bound to one editor instance. If the editor is replaced (remount, hot reload), the old manager is retired (autosave stopped, session closed) before a new one starts (§10, bug 2).

## 9. UI (`ProjectFileBar.tsx`)

- Project name (editable) and status:
  - *Not saved yet*;
  - *Unsaved changes · autosaved 12:02:57*;
  - *Autosaving…*;
  - *Autosave failed: …*;
  - *Saved · persistence-test.clipbench*.
- Buttons: **Save** (⌘S), **Save As…** (⇧⌘S), **Open…**, **Versions**, plus **Import old save** when a pre-Phase-17 localStorage save exists.
- The versions list shows each version's number, reason, time and size, with **Restore**.
- The recovery banner has **Recover** and **Not now**.
- The missing-media panel lists each item with its state (missing / needs permission / damaged), the reason, and **Relink…**. It also offers **Locate files…** and **Reconnect files**, and a confirm step for a file that isn't provably the original.
- **Add media** uses the system picker when available, so files come with read handles.

## 10. Bugs found by live testing, fixed

1. **Every normal close looked like a crash.**
   - Seen: the session's clean flag was written to IndexedDB from `pagehide`, and Chrome aborts that transaction as the page is torn down. Every reload produced a false "wasn't closed properly" banner.
   - Fix: the clean flag is also written to a synchronous store (localStorage), which completes inside the handler.
   - Regression test simulates the lost write.
2. **One project's content was autosaved under another project's id.**
   - Seen: a dev hot reload remounted the editor with a new engine, while the persistence hook's manager survived and autosaved the new demo timeline under the opened project's id.
   - Fix: managers are bound to their editor instance and retired when it is replaced; the hook also cleans up on unmount.
   - Verified live by hot-reloading with a project open.
3. **A damaged embedded matte blocked opening and saving.**
   - Seen: storing the version required the missing frame.
   - Fix: a damaged generated asset stays *damaged*, and everything else loads and saves.
4. **Relink couldn't match missing assets by content:** records of media not found on open weren't kept. Fixed; the records are adopted.
5. **A relink to the same file under a new name didn't mark the project dirty**, so the new location was never saved; relink also dropped recorded fps. Fixed.
6. **An aborted IndexedDB commit reported its error as "null".** Fixed: a real message is shown.
7. **The legacy-save warning said every file needed relinking** when all were already open. Now shown only when something is missing.

## 11. Limits

- **Native pickers.** The system Save/Open pickers can't be driven by automation. Live tests used Origin Private File System handles, which are the same `FileSystemFileHandle` API with the same atomic writable.
- **Permission prompts.** A handle needing permission ("needs permission" → **Reconnect files**) can only be produced with a real user permission prompt. That path wasn't exercised live (OPFS handles are always granted).
- **Fingerprints** hash the size and the first and last MiB, not the whole file. An edit confined to the middle of a large file isn't detected as a different file. This is a deliberate trade-off: relinking stays instant on multi-GB media.
- **Version history is per browser** (IndexedDB). The `.clipbench` file is the portable copy.
- **Media without a handle.** Media added by drag-and-drop or the fallback `<input>` has no handle: after closing the browser it must be relinked once (one **Locate files…** for all of it).
