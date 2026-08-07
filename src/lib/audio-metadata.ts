/** Reads the duration of an audio File without attaching it to the DOM. */
export function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.src = url;

    const cleanup = () => URL.revokeObjectURL(url);

    el.onloadedmetadata = () => {
      resolve(el.duration || 0);
      cleanup();
    };
    el.onerror = () => {
      cleanup();
      reject(new Error(`Could not read metadata for ${file.name}`));
    };
  });
}
