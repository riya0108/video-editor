import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * SERVER ENV (server-only). Secrets are read from process.env at RUNTIME, never through import.meta.env (Vite would
 * inline them into the build). `astro dev` doesn't put .env into process.env, and `npm start` shouldn't depend on the
 * host doing it either, so the project's .env is loaded once here — never overriding variables already set by the
 * host (production secrets win).
 */
let loaded = false;

export function serverEnv(name: string): string | undefined {
  if (!loaded) {
    loaded = true;
    const file = join(process.cwd(), ".env");
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        /* a malformed .env shouldn't take the server down; the variables are simply missing */
      }
    }
  }
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}
