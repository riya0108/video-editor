/** Reads the pixel color at a fractional (0–1) position in the current video frame. */
export function sampleVideoColor(video: HTMLVideoElement, fx: number, fy: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1;
  canvas.height = video.videoHeight || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#00ff00";
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * canvas.height)));
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
