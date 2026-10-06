import { describe, expect, it } from "vitest";
import { classifyImport, describeDecodeFailure, dragHasFiles } from "./media-import";

const file = (name: string, type: string, size = 100) => new File([new Uint8Array(size)], name, { type });

describe("classifyImport", () => {
  it("accepts images and videos, using the extension when the MIME type is missing", () => {
    expect(classifyImport(file("a.jpg", "image/jpeg"))).toEqual({ ok: true, kind: "image" });
    expect(classifyImport(file("a.mp4", "video/mp4"))).toEqual({ ok: true, kind: "video" });
    // Some systems hand over .mov with an empty type — must still be a VIDEO, not decoded as an image.
    expect(classifyImport(file("clip.mov", ""))).toEqual({ ok: true, kind: "video" });
  });
  it("accepts audio (Phase 11), by MIME type or extension; rejects browser-undecodable formats with a conversion hint", () => {
    expect(classifyImport(file("song.mp3", "audio/mpeg"))).toEqual({ ok: true, kind: "audio" });
    expect(classifyImport(file("voice.m4a", ""))).toEqual({ ok: true, kind: "audio" });
    const r = classifyImport(file("old.wma", "audio/x-ms-wma"));
    expect(!r.ok && r.message).toMatch(/^old\.wma:.*MP3/);
    expect(classifyImport(file("empty.wav", "audio/wav", 0)).ok).toBe(false);
  });
  it("explains HEIC with a concrete fix", () => {
    const r = classifyImport(file("IMG_0001.HEIC", ""));
    expect(!r.ok && r.message).toMatch(/JPG or PNG/);
    expect(classifyImport(file("x.heif", "image/heif")).ok).toBe(false);
  });
  it("rejects unknown and empty files with a message naming the file", () => {
    const r = classifyImport(file("notes.txt", "text/plain"));
    expect(!r.ok && r.message).toMatch(/^notes\.txt:/);
    expect(classifyImport(file("a.png", "image/png", 0)).ok).toBe(false);
  });
});

describe("messages", () => {
  it("decode failures name the file and suggest a working format", () => {
    expect(describeDecodeFailure(file("a.mov", "video/quicktime"), "video", new Error("Media error"))).toMatch(/a\.mov.*H\.264 MP4/);
    expect(describeDecodeFailure(file("a.png", "image/png"), "image", "bad")).toMatch(/JPG, PNG or WebP/);
  });
  it("dragHasFiles only for file drags", () => {
    expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});
