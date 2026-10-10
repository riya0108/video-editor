import { describe, expect, it } from "vitest";
import { isNonPublicAddress, parsePublicHttpUrl, resolvePublicHttpUrl } from "./public-url";

describe("public-url guard (Phase 20 SSRF fix)", () => {
  it("refuses every bypass the old hostname-text check let through", () => {
    for (const u of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:7f00:1]/",
      "http://[::]/",
      "http://[::1]/",
      "http://[::127.0.0.1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://0.1.2.3/",
      "http://100.64.0.1/",
      "http://metadata.google.internal/",
      "http://printer.lan/",
      "http://intranet/",
      "http://user:pw@example.com/",
    ])
      expect(parsePublicHttpUrl(u), u).toBeNull();
  });

  it("still refuses what the old check refused", () => {
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://localhost:3000/", "http://a.localhost/", "http://nas.local/", "http://10.1.2.3/", "http://192.168.1.1/", "http://172.20.0.1/", "http://169.254.169.254/", "http://[fd00::1]/", "http://[fe80::1]/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url"])
      expect(parsePublicHttpUrl(u), u).toBeNull();
  });

  it("accepts ordinary public media links", () => {
    for (const u of ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://www.instagram.com/reel/x/", "https://vimeo.com/1", "http://93.184.216.34/clip.mp4", "https://[2606:4700:4700::1111]/a.mp3"])
      expect(parsePublicHttpUrl(u), u).not.toBeNull();
  });

  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.100.1.1", "169.254.169.254", "172.31.255.255", "192.168.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:10.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1"]) expect(isNonPublicAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001::200e"]) expect(isNonPublicAddress(ip), ip).toBe(false);
  });

  it("refuses public names that RESOLVE to private addresses (localtest.me → 127.0.0.1), and lookup failures", async () => {
    const dns: Record<string, string[]> = { "localtest.me": ["127.0.0.1"], "mixed.example": ["93.184.216.34", "10.0.0.5"], "www.youtube.com": ["142.250.1.1", "2a00:1450:4001::200e"] };
    const lookup = async (h: string) => {
      if (!dns[h]) throw new Error("ENOTFOUND");
      return dns[h];
    };
    expect(await resolvePublicHttpUrl("http://localtest.me/", lookup)).toBeNull();
    expect(await resolvePublicHttpUrl("http://mixed.example/", lookup)).toBeNull();
    expect(await resolvePublicHttpUrl("http://nowhere.example/", lookup)).toBeNull();
    expect(await resolvePublicHttpUrl("https://www.youtube.com/watch?v=abc", lookup)).not.toBeNull();
  });
});
