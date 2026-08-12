import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "./exec.js";

const STALE_MS = 30_000;
const WAIT_MS = 10_000;

/**
 * Cross-platform advisory lock. `mkdir` is atomic everywhere including Windows,
 * which makes it the simplest correct primitive here - no dependency and no
 * O_EXCL behaviour differences to reason about.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const dir = `${file}.lock`;
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    try {
      await fs.mkdir(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Reclaim a lock left behind by a crashed process.
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${dir}`);
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a reader never observes a half-written file.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}
