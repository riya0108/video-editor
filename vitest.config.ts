import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // .agents/ contains Claude Code skill scripts with their own *.test.mjs
    // files (plain Node test scripts, not Vitest) — excluded so this config
    // never tries to run them as Vitest suites.
    // ._* are macOS metadata files written next to every file on non-Apple (exFAT) drives — not tests.
    exclude: ["node_modules", "dist", ".agents", "**/._*"],
  },
});
