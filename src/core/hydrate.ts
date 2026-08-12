import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./exec.js";
import { exists, expandGlob } from "./glob.js";
import type { HydrateConfig } from "../types.js";

/** Checked at the root when `[hydrate] lockfiles` is not set. Order is irrelevant. */
const KNOWN_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
];

export type HydrateStatus = "applied" | "skipped" | "failed";

export interface HydrateAction {
  kind: "copy" | "link" | "run";
  /** Relative path for copy/link; the command line for run. */
  target: string;
  status: HydrateStatus;
  reason?: string;
}

export interface HydrateResult {
  ok: boolean;
  source: string;
  dest: string;
  /** Lockfiles compared, relative to the root. Empty when there was nothing to compare. */
  lockfiles: string[];
  /**
   * True when every compared lockfile hashed identically - which is exactly the
   * condition under which sharing one `node_modules` between worktrees is safe.
   */
  lockfilesMatch: boolean;
  actions: HydrateAction[];
}

export interface HydrateOptions {
  /** Plan only: report every action as `skipped` with reason `dry-run`. */
  dryRun?: boolean;
  /** Overwrite copies and replace links that already exist in the destination. */
  force?: boolean;
  /** Run install commands even when the lockfiles matched and links were made. */
  run?: boolean;
  onProgress?: (action: HydrateAction) => void;
}

export function hasHydrateConfig(cfg: HydrateConfig): boolean {
  return cfg.copy.length + cfg.link.length + cfg.run.length > 0;
}

/**
 * Make a freshly-created worktree runnable.
 *
 * A new worktree is broken on arrival: everything it needs to boot - `.env`,
 * credentials, `node_modules` - is gitignored, so git does not bring it along.
 * That is the single biggest daily papercut this tool exists to remove.
 *
 * The `link` vs `run` decision is made from evidence rather than configuration:
 * identical lockfiles mean the dependency tree is byte-identical, so a link is
 * both safe and instant; differing lockfiles mean the branch changed its
 * dependencies, and sharing one directory would corrupt both worktrees.
 */
export async function hydrate(
  source: string,
  dest: string,
  cfg: HydrateConfig,
  opts: HydrateOptions = {},
): Promise<HydrateResult> {
  const actions: HydrateAction[] = [];
  const record = (action: HydrateAction) => {
    actions.push(action);
    opts.onProgress?.(action);
    return action;
  };

  for (const pattern of cfg.copy) {
    for (const rel of await expandGlob(source, pattern)) {
      record(await copyOne(source, dest, rel, opts));
    }
  }

  const { lockfiles, match } = await compareLockfiles(source, dest, cfg.lockfiles);

  for (const pattern of cfg.link) {
    for (const rel of await expandGlob(source, pattern)) {
      if (!match) {
        record({
          kind: "link",
          target: rel,
          status: "skipped",
          reason: `lockfile changed on this branch - ${cfg.run.length > 0 ? "installing instead" : "install manually"}`,
        });
        continue;
      }
      record(await linkOne(source, dest, rel, opts));
    }
  }

  // Links were made, so the dependency tree is already there. Running the install
  // command anyway would write through the link into the source worktree.
  const linked = actions.some((a) => a.kind === "link" && a.status === "applied");
  const shouldRun = opts.run === true || !linked;

  for (const command of cfg.run) {
    if (!shouldRun) {
      record({ kind: "run", target: command, status: "skipped", reason: "dependencies linked" });
      continue;
    }
    if (opts.dryRun) {
      record({ kind: "run", target: command, status: "skipped", reason: "dry-run" });
      continue;
    }
    // Through a shell: install commands are `.cmd` shims on Windows and often
    // contain `&&` regardless of platform.
    const result = await exec(command, [], { cwd: dest, shell: true, inherit: false });
    record({
      kind: "run",
      target: command,
      status: result.code === 0 ? "applied" : "failed",
      ...(result.code === 0
        ? {}
        : { reason: (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ") }),
    });
  }

  return {
    ok: actions.every((a) => a.status !== "failed"),
    source,
    dest,
    lockfiles,
    lockfilesMatch: match,
    actions,
  };
}

async function copyOne(
  source: string,
  dest: string,
  rel: string,
  opts: HydrateOptions,
): Promise<HydrateAction> {
  const from = path.join(source, rel);
  const to = path.join(dest, rel);

  if ((await exists(to)) && !opts.force) {
    return { kind: "copy", target: rel, status: "skipped", reason: "already present" };
  }
  if (opts.dryRun) return { kind: "copy", target: rel, status: "skipped", reason: "dry-run" };

  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, force: true });
    return { kind: "copy", target: rel, status: "applied" };
  } catch (err) {
    return { kind: "copy", target: rel, status: "failed", reason: (err as Error).message };
  }
}

async function linkOne(
  source: string,
  dest: string,
  rel: string,
  opts: HydrateOptions,
): Promise<HydrateAction> {
  const from = path.resolve(source, rel);
  const to = path.join(dest, rel);

  if (await exists(to)) {
    if (!opts.force) {
      return { kind: "link", target: rel, status: "skipped", reason: "already present" };
    }
    if (!opts.dryRun) await fs.rm(to, { recursive: true, force: true });
  }
  if (opts.dryRun) return { kind: "link", target: rel, status: "skipped", reason: "dry-run" };

  try {
    const stat = await fs.stat(from);
    await fs.mkdir(path.dirname(to), { recursive: true });
    // On Windows a directory junction needs neither elevation nor Developer Mode,
    // unlike a real directory symlink - which is why this is not `"dir"`. It also
    // requires an absolute target, hence the resolve above.
    const type = stat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file";
    await fs.symlink(from, to, type);
    return { kind: "link", target: rel, status: "applied" };
  } catch (err) {
    return { kind: "link", target: rel, status: "failed", reason: (err as Error).message };
  }
}

async function sha256(file: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Compare the lockfiles present in both trees.
 *
 * "No lockfile to compare" counts as a match: the caller listed those paths under
 * `link` precisely because they expect them to be shareable, and with no evidence
 * to the contrary we honour that rather than silently doing a slow full install.
 */
export async function compareLockfiles(
  source: string,
  dest: string,
  configured: string[],
): Promise<{ lockfiles: string[]; match: boolean }> {
  const candidates = configured.length > 0 ? configured : KNOWN_LOCKFILES;
  const compared: string[] = [];
  let match = true;

  for (const rel of candidates) {
    const a = await sha256(path.join(source, rel));
    if (a === null) continue;
    const b = await sha256(path.join(dest, rel));
    compared.push(rel);
    // Missing in the destination is not a mismatch: a lockfile is tracked, so a
    // fresh worktree always has it. If it is absent, the tree is not what we
    // think it is and the comparison has nothing to say.
    if (b !== null && a !== b) match = false;
  }

  return { lockfiles: compared, match };
}
