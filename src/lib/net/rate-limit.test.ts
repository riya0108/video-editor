import { describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rate-limit";

describe("rate limit", () => {
  it("allows up to max per window per client, then reports the wait", () => {
    resetRateLimits();
    const lim = { max: 3, windowMs: 10_000 };
    expect(rateLimit("r", "a", lim, 0)).toBeNull();
    expect(rateLimit("r", "a", lim, 1000)).toBeNull();
    expect(rateLimit("r", "a", lim, 2000)).toBeNull();
    expect(rateLimit("r", "a", lim, 3000)).toBe(7);
    expect(rateLimit("r", "b", lim, 3000)).toBeNull(); // other clients unaffected
    expect(rateLimit("other", "a", lim, 3000)).toBeNull(); // per route
    expect(rateLimit("r", "a", lim, 10_001)).toBeNull(); // the first hit left the window
  });
});
