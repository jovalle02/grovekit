import fs from "node:fs/promises";
import { execSafe } from "./exec.js";

export const PACKAGE_NAME = "grovekit";

/**
 * The command, and the only binary this package installs.
 *
 * One name on purpose. Every extra alias is another thing that can be shadowed,
 * another string baked into someone's hook file, and another way for two
 * installs to disagree about which one is real - all of which this project has
 * already paid for once, when `wt` turned out to be Windows Terminal on every
 * Windows PATH.
 *
 * The names it has shipped under before are listed separately, in `install`, so
 * that upgrading removes their hooks rather than leaving both installed.
 */
export const BIN_NAMES = ["grove"] as const;

export interface ResolvedBin {
  /** What to invoke: a bin name if one resolves to us, else an npx fallback. */
  command: string;
  /** Absolute path of the resolved executable, when we found one. */
  path: string | null;
  /** False when we fell back - nothing on PATH was verifiably this package. */
  verified: boolean;
  /** A binary of the right *name* that belongs to something else. */
  shadowedBy: string | null;
}

/** Everything `where`/`which` reports for a name, in resolution order. */
async function candidates(name: string): Promise<string[]> {
  const probe = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [name] : ["-a", name];
  const { code, stdout } = await execSafe(probe, args);
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Whether a file on PATH is actually this package.
 *
 * Name is not evidence. An npm shim either resolves to a path inside the package
 * or names the package in its text - a compiled `grove.exe` belonging to Windows
 * Terminal does neither, which is exactly the case that has to be caught.
 */
export async function isOurBinary(file: string): Promise<boolean> {
  const real = await fs.realpath(file).catch(() => file);
  if (real.replace(/\\/g, "/").includes(`/${PACKAGE_NAME}/`)) return true;

  // npm's shims are a kilobyte of text naming the target. Reading a real
  // executable would be pointless and slow, so size-gate it first.
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.size > 64 * 1024) return false;

  const text = await fs.readFile(file, "utf8").catch(() => null);
  return text !== null && text.includes(PACKAGE_NAME);
}

/**
 * How a hook or a doc should invoke this tool on *this* machine.
 *
 * Resolved at write time rather than assumed, because a hook that shells out to
 * a binary which is not on PATH - or is a different program with the same name  - 
 * fails silently: the session starts, nothing is injected, and nothing anywhere
 * says why.
 */
export async function resolveBin(): Promise<ResolvedBin> {
  let shadowedBy: string | null = null;

  for (const name of BIN_NAMES) {
    for (const candidate of await candidates(name)) {
      if (await isOurBinary(candidate)) return { command: name, path: candidate, verified: true, shadowedBy: null };
      // Remember the first impostor so the caller can explain the collision.
      if (shadowedBy === null) shadowedBy = candidate;
    }
  }

  return {
    command: `npx --no-install ${PACKAGE_NAME}`,
    path: null,
    verified: false,
    shadowedBy,
  };
}
