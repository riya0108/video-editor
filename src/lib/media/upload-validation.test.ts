import { describe, it, expect } from "vitest";
import { validateUploadedMediaFile } from "./upload-validation";

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(Math.min(size, 1024))], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("validateUploadedMediaFile", () => {
  it("accepts a normal image by MIME type", () => {
    const result = validateUploadedMediaFile(makeFile("photo.png", "image/png", 1024));
    expect(result).toEqual({ ok: true, kind: "image" });
  });

  it("accepts a normal video by MIME type", () => {
    const result = validateUploadedMediaFile(makeFile("clip.mp4", "video/mp4", 1024));
    expect(result).toEqual({ ok: true, kind: "video" });
  });

  it("falls back to extension when the browser reports no MIME type", () => {
    const result = validateUploadedMediaFile(makeFile("clip.mov", "", 1024));
    expect(result).toEqual({ ok: true, kind: "video" });
  });

  it("rejects an unsupported file type even with an image-like name", () => {
    const result = validateUploadedMediaFile(makeFile("not-a-photo.exe", "application/octet-stream", 1024));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doesn't look like/);
  });

  it("rejects an image over the size ceiling", () => {
    const result = validateUploadedMediaFile(makeFile("huge.png", "image/png", 200 * 1024 * 1024));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/150MB/);
  });

  it("rejects a video over the size ceiling", () => {
    const result = validateUploadedMediaFile(makeFile("huge.mp4", "video/mp4", 3 * 1024 * 1024 * 1024));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/2GB/);
  });

  it("rejects an empty file", () => {
    const result = validateUploadedMediaFile(makeFile("empty.png", "image/png", 0));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/empty/);
  });

  it("accepts a video comfortably under its own size ceiling", () => {
    const result = validateUploadedMediaFile(makeFile("clip.webm", "video/webm", 500 * 1024 * 1024));
    expect(result).toEqual({ ok: true, kind: "video" });
  });
});
