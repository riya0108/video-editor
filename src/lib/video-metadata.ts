export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
}

/** Reads basic metadata from a video File without attaching it to the DOM. */
export function readVideoMetadata(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    el.src = url;

    const cleanup = () => URL.revokeObjectURL(url);

    el.onloadedmetadata = () => {
      resolve({ width: el.videoWidth, height: el.videoHeight, duration: el.duration || 0 });
      cleanup();
    };
    el.onerror = () => {
      cleanup();
      reject(new Error(`Could not read metadata for ${file.name}`));
    };
  });
}
