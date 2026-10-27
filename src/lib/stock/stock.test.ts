import { describe, expect, it } from "vitest";
import { buildRequest, normalizeResponse } from "./providers";
import { signedProxyPath, verifySigned } from "./signing";

describe("stock providers", () => {
  it("builds requests only for configured providers and carried types", () => {
    expect(buildRequest("pexels", "image", "cats", 1, {})).toBeNull();
    expect(buildRequest("pexels", "audio", "cats", 1, { pexels: "k" })).toBeNull();
    expect(buildRequest("pexels", "video", "", 1, { pexels: "k" })?.url).toContain("/videos/popular");
    expect(buildRequest("pexels", "image", "red car", 2, { pexels: "k" })).toEqual({ url: "https://api.pexels.com/v1/search?query=red%20car&per_page=24&page=2", headers: { Authorization: "k" } });
    expect(buildRequest("openverse", "audio", "rain", 1, {})?.url).toContain("license_type=commercial,modification");
    expect(buildRequest("pixabay", "video", "sea", 99, { pixabay: "p" })?.url).toContain("page=50");
  });

  it("normalizes Pexels videos to the best HD mp4", () => {
    const { items, hasMore } = normalizeResponse("pexels", "video", {
      next_page: "x",
      videos: [{ id: 7, url: "https://www.pexels.com/video/7/", image: "https://images.pexels.com/t.jpg", duration: 12, user: { name: "Ann", url: "https://www.pexels.com/@ann" }, video_files: [
        { file_type: "video/mp4", link: "https://videos.pexels.com/4k.mp4", width: 3840, height: 2160 },
        { file_type: "video/mp4", link: "https://videos.pexels.com/hd.mp4", width: 1920, height: 1080 },
        { file_type: "video/mp4", link: "https://videos.pexels.com/sd.mp4", width: 960, height: 540 },
      ] }, { id: 8, video_files: [] }],
    });
    expect(hasMore).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "pexels-v7", url: "https://videos.pexels.com/hd.mp4", width: 1920, durationSec: 12, author: "Ann", license: "Pexels License" });
  });

  it("normalizes Openverse with its license and credit line", () => {
    const { items, hasMore } = normalizeResponse("openverse", "audio", { page: 1, page_count: 3, results: [{ id: "a1", title: "Rain", url: "https://cdn.example/rain.mp3", creator: "Bo", license: "by", license_version: "4.0", duration: 61500, foreign_landing_url: "https://example/rain", attribution: '"Rain" by Bo is licensed under CC BY 4.0.' }] });
    expect(hasMore).toBe(true);
    expect(items[0]).toMatchObject({ license: "CC BY 4.0", durationSec: 61.5, attribution: '"Rain" by Bo is licensed under CC BY 4.0.' });
  });

  it("ignores malformed upstream data instead of throwing", () => {
    expect(normalizeResponse("pixabay", "image", null).items).toEqual([]);
    expect(normalizeResponse("pexels", "image", { photos: [{ id: 1, src: {} }, "junk"] }).items).toEqual([]);
  });
});

describe("signed proxy links", () => {
  it("accepts only the exact URL it signed, until it expires", () => {
    const path = signedProxyPath("https://images.pexels.com/a.jpg", 1_000);
    const q = new URLSearchParams(path.split("?")[1]);
    expect(verifySigned(q.get("u"), q.get("e"), q.get("s"), 2_000)).toBe("https://images.pexels.com/a.jpg");
    expect(verifySigned("http://169.254.169.254/", q.get("e"), q.get("s"), 2_000)).toBeNull();
    expect(verifySigned(q.get("u"), String(Number(q.get("e")) + 1), q.get("s"), 2_000)).toBeNull();
    expect(verifySigned(q.get("u"), q.get("e"), q.get("s"), Number(q.get("e")) + 1)).toBeNull();
    expect(verifySigned(null, null, null)).toBeNull();
  });
});
