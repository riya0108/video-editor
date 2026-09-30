import { describe, it, expect } from "vitest";
import { createCollectingLogger, createNullLogger } from "./logger";

describe("createCollectingLogger", () => {
  it("captures each call as one structured LogEntry, in order", () => {
    const { logger, entries } = createCollectingLogger();
    logger.info("stage-a", "starting");
    logger.warn("stage-b", "something odd", { count: 3 });
    logger.error("stage-c", "failed", { reason: "boom" });

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ level: "info", stage: "stage-a", message: "starting" });
    expect(entries[1]).toMatchObject({ level: "warn", stage: "stage-b", message: "something odd", data: { count: 3 } });
    expect(entries[2]).toMatchObject({ level: "error", stage: "stage-c", message: "failed", data: { reason: "boom" } });
    for (const entry of entries) expect(typeof entry.ts).toBe("number");
  });
});

describe("createNullLogger", () => {
  it("never throws for any log level", () => {
    const logger = createNullLogger();
    expect(() => {
      logger.debug("s", "m");
      logger.info("s", "m");
      logger.warn("s", "m");
      logger.error("s", "m");
    }).not.toThrow();
  });
});
