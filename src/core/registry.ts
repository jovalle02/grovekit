import path from "node:path";
import fs from "node:fs/promises";
import { readJson, withLock, writeJson } from "./lock.js";
import { registryFile } from "./paths.js";

export const REGISTRY_SCHEMA_VERSION = 1;

export interface RegistryEntry {
  slug: string;
  /** Absolute path to the worktree root. The primary key. */
  root: string;
  branch: string;
  /** Main worktree of the repo this belongs to, so `gc` can group by repository. */
  repo: string;
  createdAt: string;
}

export interface Registry {
  schemaVersion: number;
  worktrees: RegistryEntry[];
}

/**
 * A *new* empty registry each time. Sharing one constant means the fallback's
 * array is the same object every caller gets, and the first `register()` on a
 * machine with no registry file pushes into it - so a later read of a different,
 * genuinely empty registry returns the earlier entry from memory.
 */
const empty = (): Registry => ({ schemaVersion: REGISTRY_SCHEMA_VERSION, worktrees: [] });

/**
 * A machine-global index of every worktree `grove` has touched.
 *
 * It is a cache, never an authority: `grove ls` still enumerates from git, because a
 * worktree created by hand is just as real as one created by `grove new`. What the
 * registry buys is the ability to answer questions from *outside* any worktree -
 * chiefly `grove gc`, which has to recognise containers and leases whose worktree no
 * longer exists and therefore cannot be asked.
 */
export async function readRegistry(): Promise<Registry> {
  const reg = await readJson<Registry | null>(registryFile(), null);
  if (!reg) return empty();
  return {
    schemaVersion: reg.schemaVersion ?? REGISTRY_SCHEMA_VERSION,
    worktrees: Array.isArray(reg.worktrees) ? [...reg.worktrees] : [],
  };
}

async function update<T>(fn: (reg: Registry) => Promise<T> | T): Promise<T> {
  const file = registryFile();
  return withLock(file, async () => {
    const reg = await readRegistry();
    const result = await fn(reg);
    await writeJson(file, reg);
    return result;
  });
}

/** Upsert by root. Re-registering an existing worktree refreshes slug and branch. */
export async function register(entry: Omit<RegistryEntry, "createdAt">): Promise<RegistryEntry> {
  const root = path.resolve(entry.root);
  return update((reg) => {
    const existing = reg.worktrees.find((w) => path.resolve(w.root) === root);
    if (existing) {
      existing.slug = entry.slug;
      existing.branch = entry.branch;
      existing.repo = path.resolve(entry.repo);
      return existing;
    }
    const created: RegistryEntry = {
      slug: entry.slug,
      root,
      branch: entry.branch,
      repo: path.resolve(entry.repo),
      createdAt: new Date().toISOString(),
    };
    reg.worktrees.push(created);
    return created;
  });
}

export async function unregister(root: string): Promise<boolean> {
  const target = path.resolve(root);
  return update((reg) => {
    const before = reg.worktrees.length;
    reg.worktrees = reg.worktrees.filter((w) => path.resolve(w.root) !== target);
    return reg.worktrees.length !== before;
  });
}

/** Registry entries whose directory has since vanished. */
export async function staleEntries(): Promise<RegistryEntry[]> {
  const reg = await readRegistry();
  const out: RegistryEntry[] = [];
  for (const entry of reg.worktrees) {
    try {
      await fs.stat(entry.root);
    } catch {
      out.push(entry);
    }
  }
  return out;
}

export async function findBySlug(slug: string): Promise<RegistryEntry | undefined> {
  return (await readRegistry()).worktrees.find((w) => w.slug === slug);
}
