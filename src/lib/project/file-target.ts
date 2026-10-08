import type { ProjectFileTarget } from "./manager";

/**
 * PROJECT FILE TARGETS (PROJECT_PERSISTENCE_ARCHITECTURE.md §3) — the only code that writes a project to disk.
 *
 * File System Access writes are ATOMIC: `createWritable()` writes to a temporary swap file and `close()` replaces the
 * target in one step; `abort()` (or the tab dying) discards the swap file. An interrupted save therefore leaves the
 * previous project file byte-for-byte intact. On any error we abort explicitly.
 *
 * NEVER OVERWRITE SOURCE MEDIA: before writing, the target is compared (`isSameEntry`) with every source-media handle
 * the session or the local database knows, and the name must end in `.clipbench`. Either check failing refuses the
 * save before a byte is written.
 */

export const PROJECT_EXTENSION = ".clipbench";

export class SaveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveRefusedError";
  }
}

export interface HandleTargetOptions {
  /** Every known source-media handle (registry + stored), checked before writing. */
  sourceHandles: () => Promise<FileSystemFileHandle[]>;
  /** TEST ONLY: write this many bytes, then fail — simulates a save interrupted mid-write. */
  faultAfterBytes?: number;
}

export function handleTarget(handle: FileSystemFileHandle, opts: HandleTargetOptions): ProjectFileTarget {
  return {
    name: handle.name,
    handle,
    async write(bytes: Uint8Array) {
      if (!handle.name.toLowerCase().endsWith(PROJECT_EXTENSION)) throw new SaveRefusedError(`Projects are saved as ${PROJECT_EXTENSION} files; "${handle.name}" isn't one. Nothing was written.`);
      for (const src of await opts.sourceHandles()) {
        if (await handle.isSameEntry(src).catch(() => false)) throw new SaveRefusedError(`"${handle.name}" is one of this project's source media files. Source media is never overwritten — choose another file name.`);
      }
      const perm = await (handle as FileSystemFileHandle & { queryPermission?: (d: { mode: string }) => Promise<PermissionState> }).queryPermission?.({ mode: "readwrite" });
      if (perm === "prompt") await (handle as FileSystemFileHandle & { requestPermission: (d: { mode: string }) => Promise<PermissionState> }).requestPermission({ mode: "readwrite" });
      const w = await handle.createWritable({ keepExistingData: false });
      try {
        if (opts.faultAfterBytes !== undefined) {
          await w.write(bytes.subarray(0, opts.faultAfterBytes) as Uint8Array<ArrayBuffer>);
          throw new Error(`Simulated interruption after ${opts.faultAfterBytes} bytes.`);
        }
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
      } catch (e) {
        await w.abort().catch(() => {});
        throw e;
      }
    },
  };
}

/** Browsers without the File System Access API: Save As downloads the file (the browser's download is the atomic step). */
export function downloadTarget(name: string): ProjectFileTarget {
  const fileName = name.toLowerCase().endsWith(PROJECT_EXTENSION) ? name : `${name}${PROJECT_EXTENSION}`;
  return {
    name: fileName,
    async write(bytes: Uint8Array) {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}

type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
};

export const fsAccessAvailable = () => typeof window !== "undefined" && typeof (window as PickerWindow).showSaveFilePicker === "function";

const PROJECT_TYPES = [{ description: "Clipbench project", accept: { "application/octet-stream": [PROJECT_EXTENSION] } }];

export async function pickSaveHandle(suggestedName: string): Promise<FileSystemFileHandle> {
  return (window as PickerWindow).showSaveFilePicker!({ suggestedName: suggestedName.endsWith(PROJECT_EXTENSION) ? suggestedName : `${suggestedName}${PROJECT_EXTENSION}`, types: PROJECT_TYPES });
}

export async function pickOpenHandle(): Promise<FileSystemFileHandle> {
  const [h] = await (window as PickerWindow).showOpenFilePicker!({ types: PROJECT_TYPES, multiple: false });
  return h;
}

/** Media picker that also returns READ handles (so the project can find the files again next time). */
export async function pickMediaWithHandles(accept: Record<string, string[]>): Promise<{ file: File; handle?: FileSystemFileHandle }[]> {
  const w = window as PickerWindow;
  if (typeof w.showOpenFilePicker !== "function") return [];
  const handles = await w.showOpenFilePicker({ multiple: true, types: [{ description: "Media", accept }] });
  return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
}
