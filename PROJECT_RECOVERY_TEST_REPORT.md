# Phase 17 — Project Persistence & Recovery: Test Report

Date: 2026-10-08.

**Environment:**
- macOS, Node 22, Vitest 5.
- Chrome 154 via chrome-devtools-mcp, with real IndexedDB and real `FileSystemFileHandle`s in the Origin Private File System.
- Astro dev server (`/tools/video/composition-preview`).

## Summary

| Check | Result |
|---|---|
| Full test suite | **1192 passed**, 28 skipped (88 files). The skips are the Phase 15/16 per-file eval cases. |
| New: `src/lib/project/project.test.ts` | **41 / 41** |
| `tsc` / `astro check` / production build | **0 errors** / **0 errors, 0 warnings** / **Complete** |
| Live: create → save → close → reopen → compare | **identical**: canonical document SHA-256 equal; 5 full-resolution frames bit-identical; 7/7 media resolved |
| Live: crash (renderer process killed) → recover | **identical** to the last autosave; 5/5 frames bit-identical |
| Live: missing media | detected on open; wrong file refused; relinked by UI (exact + by content under a new name) |
| Live: corrupted files (doc byte flipped, truncated, random) | **refused** with the reason through the real Open UI; open project unchanged |
| Live: damaged embedded matte | opens; frame **healed** from the browser's copy; state and pixels identical to the save |
| Live: interrupted save over the real project file | file **byte-identical** afterwards and still opens; nothing recorded as saved |
| Live: aborted database commit | no partial version, revision not consumed, error shown, retry succeeds |
| Live: never overwrite source media | `.mp4` target and a same-entry `.clipbench`-named source both **refused**; both files unchanged |
| Live: versions UI | restore of v7 by click → identical to the original save; replaced state kept as a restore point |
| Browser console during all live tests | **0 errors / 0 warnings** |

## 1. Create → save → close → reopen → compare

**The project** was built in the live editor through the editor's own actions (`persistence-harness.ts`, `buildComplexInEditor`):

| Feature | How |
|---|---|
| Assets | the demo video (app URL), two generated stills, plus three **user files** picked with read handles: a video, a 50 %-alpha PNG and a WAV |
| Clips / text / graphics | 13 clips on 11 tracks; title text edited; a new ellipse graphic |
| Transforms / crops | PiP crop and rotation; uploaded video cropped, scaled, rotated; logo transform, opacity, screen blend |
| Keyframes | badge x (2 keys); counter opacity (2 keys) |
| Effects | saturation on the logo; brightness on the counter |
| Transitions | main video split at frame 120, 20-frame cross-dissolve |
| Audio | tone volume 0.7, fade in 10 / out 20 frames; PiP muted (demo) |
| Captions | 2 cues imported, one with word timings |
| Masks | ellipse mask on the counter video |
| Mattes | **real background removal (U²-Net)** on the uploaded image, stored as generated media; plus the demo's PiP matte |
| AI results | real face, shot and silence analyses; a shot item rejected and another's end edited by hand |
| Export settings | Square preset, then 25 fps (modified), set through the real export panel |
| Guides | one vertical guide |

**Save** went through `manager.saveAs` with the production `handleTarget`, onto a real file handle (`persistence-test.clipbench`). The result was revision 7: a 293,223-byte file with 4 entries.

**Independent inspection (Python):**
- signature, declared length and whole-file SHA-256 are correct, and every entry's SHA-256 matches;
- `project.json` (21 KB) plus exactly 3 PNGs: the U²-Net matte (245 KB), the demo logo and the demo matte;
- the user's source media is **not** in the file. There is no MP4 box and no WAV header, and the source video's bytes are absent. They are referenced by name and fingerprint.

**Close:** the page was navigated away (`about:blank`), which discarded all in-memory state, then the app was loaded fresh.

**Reopen:** the saved file was opened in the fresh page. Media resolution:
- the demo video came from its URL;
- the generated stills and the U²-Net matte came from the file;
- the three user files were found automatically through their **stored read handles**.

The open took 208 ms.

**Compare:**
- the canonical project document (timeline, assets, AI results, export settings, playhead) is **byte-identical**: SHA-256 `245b8e60…` before and after;
- frames 0, 45, 110, 130 and 200, rendered at full quality by the final renderer, are **bit-identical** (SHA-256 of the full-resolution pixels);
- status: "Saved · persistence-test.clipbench", not dirty, nothing missing.

## 2. Crash

1. Opened the project and made unsaved edits (title moved, rotated, two new opacity keyframes).
2. Waited for autosave (v10, "Unsaved changes · autosaved 12:02:57").
3. **Killed the tab's renderer process** with `kill -9`. It was identified as the only renderer at 99 % CPU while the page busy-looped, in the devtools test profile. No `pagehide`, no clean flag and no final write.
4. Opened the app in a new tab.

**Result:**
- The banner read: *"Persistence test wasn't closed properly. Unsaved work from 12:02:57 (version 10) can be recovered."*
- After clicking **Recover**, the state is byte-identical to the autosaved state and frames 0/45/110/130/200 are bit-identical.
- All 7 media items resolved again (user files through their handles).
- The project is dirty (the work isn't in the file yet) and recorded as v11 "recovered". The banner doesn't return.

## 3. Missing media

The two OPFS test copies of the user's video and WAV were removed to simulate files that were moved or deleted. In a fresh session, the project was opened through the real Open UI.

- **Detection:**
  - message: "2 media item(s) need attention below";
  - the panel lists `counter30.mp4` and `tone.wav` as **MISSING**: "was moved or deleted";
  - the logo, still in place, was found automatically through its handle.
- **Wrong file:** chose the PNG for the video's **Relink…** → "Relink failed: "counter30.mp4" was a video; the chosen file is an image". Nothing changed.
- **Real file:** chose `counter30.mp4` → "Relinked … to counter30.mp4", an *exact* match.
- **Moved and renamed:** **Locate files…** with a decoy PNG plus `tone-moved-and-renamed.wav` → "Relinked 1 item(s) by content." The panel disappeared.
- **Compare:** frames 0/45/110/130/200 are bit-identical to the original save. The document differs only in the tone's recorded file name and date, which is exactly what changed.

## 4. Corrupted project

Damaged copies of the saved file were opened through the real Open UI (the file-input path).

| File | Result in the UI | Editor afterwards |
|---|---|---|
| one byte flipped inside `project.json` | "Open failed: The project file is damaged: project.json failed verification." | unchanged (SHA-256 equal) |
| truncated to 60 % | "Open failed: The project file is incomplete: its end marker is missing (the save was probably interrupted)." | unchanged |
| 5 KB of random bytes | "Open failed: Not a Clipbench project file (wrong signature)." | unchanged |
| one byte flipped inside an embedded matte PNG | opened: "An embedded media frame was damaged in the file; restored it from this browser's copy (a5dcd0d51731…)." | identical to the saved project; frames bit-identical |
| a pre-Phase-17 timeline-only JSON | opened: "Upgraded from clipbench-timeline v10…" | 13 clips |

Node tests also cover:
- a damaged matte with **no** local copy (the asset is marked *damaged* and everything else loads);
- a damaged version in local history (refused by checksum);
- invalid timeline, AI results or asset records (refused);
- a newer format version (refused);
- invalid export settings and playhead (defaults with a warning).

## 5. Interrupted save

| Scenario | Result |
|---|---|
| **Live, real file handle:** `save()` over the existing project file with a writer that fails after 4,096 bytes | error surfaced; the file is **byte-identical** (SHA-256 equal, still 293,223 bytes) and still decodes; `savedRevision` unchanged; still dirty; no "save" version recorded. The next save succeeded (v14). |
| **Live, database:** autosave with the IndexedDB transaction aborted mid-commit | status "Autosave failed: The transaction was aborted…"; no partial version; head revision not consumed; the retry stored it |
| Node: non-atomic writer (a cut-off download leaves a torn file) | the torn file is refused on open as corrupt; the state is in local history |
| Node: quota error during a commit | nothing applied; the next autosave takes the same revision number |

## 6. Never overwrite source media

Live, with real handles:
- **Save As onto the user's `counter30.mp4`:** "Projects are saved as .clipbench files; "counter30.mp4" isn't one. Nothing was written."
- **Save As onto a source file that happens to be called `my-footage.clipbench`:** "… is one of this project's source media files. Source media is never overwritten — choose another file name." This is refused by `isSameEntry` identity, not by name.
- Both files are byte-identical afterwards. The following real save landed only in the project file.

## 7. Versioning

- **Versions UI:** lists v1–v15 with reason, time and size.
- **Restore v7 by click:** "Restored version 7. What you had before is kept as a restore point."
  - The editor is byte-identical to the original v7 save, and frames are bit-identical.
  - The history gained "v16 Before restore" and "v17 Restored".
  - The project is dirty, since v7 ≠ the file's v14.
- **Node:** restore and restore-back, "before-open" on opening another project, retention (50 saves + 20 others, newest never pruned), autosave skipping unchanged content.

## Bugs found by live testing, fixed

1. **False crash prompts after every normal close.**
   - Cause: the clean flag was written to IndexedDB from `pagehide`, and Chrome aborts that transaction during teardown. All six session rows were `clean: false`, and every reload offered "recovery".
   - Fix: a synchronous localStorage flag.
   - Regression test drops the IndexedDB write and checks that the session is still recognised as clean.
2. **Cross-project autosave.**
   - Seen: after a dev hot reload, versions 8 and 9 of "Persistence test" contained the *demo* timeline (6 tracks, track ids created after the opened project's).
   - Cause: Fast Refresh remounted the editor with a new engine while the hook's manager survived.
   - Fix: managers are bound to their editor instance, retired when it is replaced, and disposed on unmount.
   - Re-test: hot reload with the project open → a new manager and project id; the opened project's history was untouched (still 9 versions).
   - The two bad versions written before the fix remain in that test project's local history.
3. **A damaged embedded matte failed the whole open** (Node test). The damaged asset is now isolated.
4. **Relink couldn't compare against missing assets** (Node test). Their records are now kept.
5. **Relinked under a new name stayed "clean"**, so the new location wasn't saved; relink also dropped recorded fps. Fixed and tested.
6. **The aborted-commit error read "null".** It is now a real message.
7. **A misleading legacy warning** ("every media file has to be relinked" when none were missing) is now conditional.

Also found while testing (test-side, not product):
- the fixture's audio fields were misnamed;
- my corrupted-byte offset in one Node test hit the manifest rather than `project.json`;
- the AI harness read a job id as a result id.

## Automated (Node): `project.test.ts`

| Area | Asserted |
|---|---|
| Bundle | exact round trip; truncation at 4 points and extension detected; a flipped document byte is fatal, a flipped media byte is tolerated and reported; wrong signature, damaged table of contents and random bytes are refused |
| Document | every listed feature survives a round trip (spot-checked field by field); normalization is idempotent; legacy migration; invalid timeline, AI results or assets and newer versions are refused; invalid auxiliary data falls back with warnings |
| Assets | usage (media/matte, furthest frame); fingerprint (same content under any name, edge edits detected, middle edits not, by design); match classes; relink checks (kind, length, size warning, audio from a video) |
| Storage | retention; failed commit applies nothing |
| Autosave | debounce and cap; no overlap; error, retry |
| Crash detection | crashed vs clean vs alive vs saved sessions; heartbeat and clean flag; **lost pagehide write regression**; dead-session pruning |
| Manager | save → close → reopen identical (in a different "browser" with no local history); no source bytes in the file; Save / Save As revisions; autosave content dedupe; crash → recover identical; corrupted file / embedded media / local version; interrupted save (atomic and torn); interrupted commit; missing media + relink (refusals, confirmation, renamed, exact-same stays clean); `relinkMany`; legacy open; versions restore and restore-back; before-open snapshot; deterministic bytes |

## Not covered

- **System pickers.** The Save/Open pickers (`showSaveFilePicker` / `showOpenFilePicker`) need a human. Every write and read went through the same target code with OPFS handles, which share their API and atomic semantics.
- **The "needs permission" → Reconnect path.** It requires a real permission prompt; OPFS handles are always granted. Its logic is in `media-host.ts` and has no automated test.
- **Browsers without File System Access** (download fallback): not run.
- **Large projects:** minutes-long timelines and multi-GB media. Fingerprinting reads at most 2 MiB per file by design; the bundle and version sizes measured here were 293 KB and 21 KB.
