import { isIP } from "node:net";

/**
 * PUBLIC-URL GUARD for server routes that fetch user-supplied URLs (src/pages/api/transcribe-source.ts). Phase 20
 * security audit (RELEASE_CANDIDATE_REPORT.md §4): the previous check compared the hostname TEXT against a few private
 * prefixes, so IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]` — the cloud metadata service),
 * `[::]`, `0.x.x.x`, carrier-grade NAT, and public names that RESOLVE to private addresses (`localtest.me` → 127.0.0.1)
 * all passed. Now: the URL's host is parsed as an address in every form Node accepts, every address the name resolves
 * to is checked, and anything not globally routable is refused.
 *
 * Residual risk (documented, not solvable here): the downloader (yt-dlp) resolves and connects on its own and follows
 * HTTP redirects, so DNS rebinding or a redirect to an internal address can't be blocked from inside the app. A
 * deployment must also deny the server process egress to private ranges (firewall / egress proxy).
 */

/** True when an IPv4 address (dotted quad) is not a public unicast address. */
export function isNonPublicIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && p[2] === 100) || // TEST-NET-2
    (a === 203 && b === 0 && p[2] === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address into its 8 hextets (handles "::", a zone id, and an embedded dotted IPv4 tail). */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const q = v4.slice(2).map(Number);
    if (q.some((n) => n > 255)) return null;
    s = `${v4[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(parts.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}

/** True when an IPv6 address is not a public unicast address (incl. IPv4-mapped/compatible/NAT64 forms of private IPv4). */
export function isNonPublicIPv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const zeroPrefix = (n: number) => h.slice(0, n).every((x) => x === 0);
  const embeddedV4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && h[7] === 1) return true; // ::1
  if (zeroPrefix(5) && h[5] === 0xffff) return isNonPublicIPv4(embeddedV4()); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return isNonPublicIPv4(embeddedV4()); // ::a.b.c.d (deprecated compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b) return isNonPublicIPv4(embeddedV4()); // NAT64 64:ff9b::/96
  if ((h[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

export function isNonPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isNonPublicIPv4(ip);
  if (v === 6) return isNonPublicIPv6(ip);
  return true;
}

const BLOCKED_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Syntax-level check: an http(s) URL whose host is not a literal non-public address or an internal-only name. */
export function parsePublicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || BLOCKED_NAME.test(host) || !host.includes(".") && !isIP(host)) return null;
  if (isIP(host) && isNonPublicAddress(host)) return null;
  return url;
}

/** Full check: syntax, then every address the host resolves to must be public. `lookup` is injectable for tests. */
export async function resolvePublicHttpUrl(raw: string, lookup: (host: string) => Promise<string[]> = defaultLookup): Promise<URL | null> {
  const url = parsePublicHttpUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) return null;
  return url;
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}
