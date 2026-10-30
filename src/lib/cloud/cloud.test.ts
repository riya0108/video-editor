import { describe, expect, it } from "vitest";
import { echoFeature, getFeature } from "./features";
import { ownsUploadPath, safeFileName, uploadPathFor } from "./storage";
import { secondsUntilReset, publicJob } from "./http";
import { isConnectionError, type Job } from "./db";

describe("cloud features", () => {
  it("validate untrusted params and price at least 1 credit", () => {
    expect(echoFeature.parse({ text: "hi" })).toEqual({ text: "hi", fail: false, delayMs: 0 });
    expect(() => echoFeature.parse({ text: "" })).toThrow();
    expect(() => echoFeature.parse({ text: "x".repeat(201) })).toThrow();
    expect(() => echoFeature.parse(null)).toThrow();
    expect(echoFeature.parse({ text: "a", delayMs: 99_999 }).delayMs).toBe(10_000);
    expect(echoFeature.estimate({ text: "a" }).credits).toBeGreaterThanOrEqual(1);
    expect(getFeature("nope")).toBeUndefined();
  });
});

describe("upload paths", () => {
  const user = "4f6d1c2e-1111-4a5b-9c8d-123456789abc";
  it("are always inside the owner's folder, with a safe name", () => {
    const p = uploadPathFor(user, "../../etc/My Voice (final).mp3");
    expect(p.startsWith(`${user}/`)).toBe(true);
    expect(p.endsWith("/etc_My_Voice_final_.mp3")).toBe(true);
    expect(ownsUploadPath(user, p)).toBe(true);
  });
  it("reject other users' folders and traversal", () => {
    const p = uploadPathFor(user, "a.wav");
    expect(ownsUploadPath("someone-else", p)).toBe(false);
    expect(ownsUploadPath(user, `${user}/../x/a.wav`)).toBe(false);
    expect(ownsUploadPath(user, `${user}/not-a-uuid/a.wav`)).toBe(false);
    expect(ownsUploadPath(user, `${user}/${p.split("/")[1]}/a b.wav`)).toBe(false);
    expect(safeFileName("...")).toBe("upload");
  });
});

describe("http helpers", () => {
  it("counts down to 00:00 UTC", () => {
    expect(secondsUntilReset(new Date("2026-10-27T23:59:00Z"))).toBe(60);
    expect(secondsUntilReset(new Date("2026-10-27T00:00:00Z"))).toBe(86_400);
  });
  it("never exposes internal job fields to the browser", () => {
    const j = { id: "1", userKey: "a:secret", userId: null, feature: "echo", status: "failed", params: { text: "x" }, consent: false, uploadPaths: ["u/p"], creditDay: "2026-10-27", estCredits: 1, estUsd: 0.01, chargedCredits: 0, costUsd: 0.5, result: { leak: true }, error: "boom", attempts: 1, maxAttempts: 3, createdAt: "", startedAt: null, finishedAt: null } as Job;
    const pub = publicJob(j);
    expect(pub).not.toHaveProperty("userKey");
    expect(pub).not.toHaveProperty("costUsd");
    expect(pub).not.toHaveProperty("uploadPaths");
    expect(pub.result).toBeNull(); // results only for succeeded jobs
    expect(pub.error).toBe("boom");
  });
});

describe("database connection errors", () => {
  it("tell a broken connection apart from a failed query", () => {
    const sys = (code: string) => Object.assign(new Error(`read ${code}`), { code });
    expect(isConnectionError(sys("ECONNRESET"))).toBe(true);
    expect(isConnectionError(sys("ETIMEDOUT"))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("insufficient_credits"), { code: "P0001" }))).toBe(false);
    expect(isConnectionError(new Error("syntax error"))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});
