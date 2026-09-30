export type LogLevel = "debug" | "info" | "warn" | "error";

/** One structured log record — every logger call emits exactly one of these, not a free-form string, so a sink can filter/aggregate/assert on `stage` and `level` instead of parsing text. */
export interface LogEntry {
  ts: number;
  level: LogLevel;
  /** Pipeline stage this entry came from, e.g. "model-selection", "alpha-refinement" — matches the stage names used throughout pipeline/remove-background.ts. */
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface MattingLogger {
  debug(stage: string, message: string, data?: Record<string, unknown>): void;
  info(stage: string, message: string, data?: Record<string, unknown>): void;
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
  error(stage: string, message: string, data?: Record<string, unknown>): void;
}

const CONSOLE_BY_LEVEL: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function defaultSink(entry: LogEntry): void {
  const fn = CONSOLE_BY_LEVEL[entry.level];
  if (entry.data) fn(`[matting:${entry.stage}] ${entry.message}`, entry.data);
  else fn(`[matting:${entry.stage}] ${entry.message}`);
}

/** Builds a logger that hands every call to `sink` as one LogEntry. Defaults to printing through the matching console method — pass a custom sink (see createCollectingLogger) to capture entries instead, e.g. for tests or a future in-app debug panel. */
export function createLogger(sink: (entry: LogEntry) => void = defaultSink): MattingLogger {
  const emit = (level: LogLevel, stage: string, message: string, data?: Record<string, unknown>) => {
    sink({ ts: Date.now(), level, stage, message, data });
  };
  return {
    debug: (stage, message, data) => emit("debug", stage, message, data),
    info: (stage, message, data) => emit("info", stage, message, data),
    warn: (stage, message, data) => emit("warn", stage, message, data),
    error: (stage, message, data) => emit("error", stage, message, data),
  };
}

/** Collects every entry into an array instead of printing — for tests that want to assert on stage progression/timing without depending on console output. */
export function createCollectingLogger(): { logger: MattingLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: createLogger((e) => entries.push(e)), entries };
}

/** Discards everything — for tests/paths that don't care about log output but still need a MattingLogger to pass in. */
export function createNullLogger(): MattingLogger {
  return createLogger(() => {});
}
