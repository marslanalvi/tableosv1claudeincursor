import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load the repo-root `.env` (or a local one) before `loadEnv()` validates it.
 * Variables already present in the environment win, so ports/DB can be
 * overridden per process.
 */
export function loadDotEnvFile(): void {
  const rootEnv = resolve(process.cwd(), "../../.env");
  const localEnv = resolve(process.cwd(), ".env");
  if (existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  } else if (existsSync(localEnv)) {
    process.loadEnvFile(localEnv);
  }
}
