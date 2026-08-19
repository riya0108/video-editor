/** Builds a silent (all-zero) 16-bit PCM WAV file — a real media file rather
 * than an ffmpeg lavfi source, so it behaves like any other input. */
export function createSilentWav(durationSeconds: number, sampleRate = 44100, channels = 2): Blob {
  const numSamples = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // Sample bytes are left at 0 — that's silence for signed PCM.

  return new Blob([buffer], { type: "audio/wav" });
}
