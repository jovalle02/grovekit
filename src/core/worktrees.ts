import path from "node:path";
import { ContextError, gitRoot } from "./context.js";
import { listWorktrees } from "./git.js";
import { readJson } from "./lock.js";
import { readManifest } from "./manifest.js";
import { readRegistry } from "./registry.js";
import { stateFile } from "./paths.js";
import type { Manifest, WorktreeState } from "../types.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Null until the worktree has run a `wt` command and written `.wt/state.json`. */
  slug: string | null;
  /** The main worktree cannot be removed, and `wt rm` must refuse it. */
  main: boolean;
  manifest: Manifest | null;
}

/**
 * Read a worktree's identity, applying the same guard as `loadContext`: a state
 * file naming a different directory arrived by commit or by copy, and trusting
 * its slug would point one worktree's commands at another's containers.
 */
export async function readState(root: string): Promise<WorktreeState | null> {
  const state = await readJson<WorktreeState | null>(stateFile(root), null);
  if (!state) return null;
  if (!state.root || path.resolve(state.root) !== path.resolve(root)) return null;
  return state;
}

/** Every worktree git knows about, with whatever `wt` state each one carries. */
export async function surveyWorktrees(cwd = process.cwd()): Promise<WorktreeInfo[]> {
  const root = await gitRoot(cwd);
  const list = await listWorktrees(root);

  return Promise.all(
    list.map(async (wt, index) => {
      const [state, manifest] = await Promise.all([readState(wt.path), readManifest(wt.path)]);
      return {
        path: wt.path,
        branch: wt.branch,
        slug: state?.slug ?? manifest?.worktree ?? null,
        main: index === 0,
        manifest,
      };
    }),
  );
}

/**
 * Find one worktree by slug, branch, directory name or path.
 *
 * Accepting all four is a deliberate ergonomic choice: an agent reading a
 * manifest has the slug, a human has the branch they were just on, and a shell
 * completion offers the directory.
 */
export async function resolveWorktree(selector: string, cwd = process.cwd()): Promise<WorktreeInfo> {
  const all = await surveyWorktrees(cwd);
  const wanted = path.resolve(cwd, selector);

  const match =
    all.find((w) => w.slug === selector) ??
    all.find((w) => w.branch === selector) ??
    all.find((w) => path.resolve(w.path) === wanted) ??
    all.find((w) => path.basename(w.path) === selector);

  if (!match) {
    const known = all
      .map((w) => w.slug ?? path.basename(w.path))
      .filter(Boolean)
      .join(", ");
    throw new ContextError(`No worktree matches "${selector}".`, `Known: ${known}`);
  }
  return match;
}

/**
 * Slugs that are legitimately in use anywhere on this machine.
 *
 * `wt gc` deletes what is *not* in this set, so a false negative destroys a live
 * stack. Both sources therefore contribute: the registry covers other repos, and
 * the git listing covers worktrees of this repo that predate the registry.
 */
export async function liveSlugs(cwd = process.cwd()): Promise<Set<string>> {
  const slugs = new Set<string>();

  const registry = await readRegistry();
  for (const entry of registry.worktrees) {
    // An entry whose directory is gone is exactly what gc is here to clean up,
    // so it must not protect anything.
    const state = await readState(entry.root);
    if (state) slugs.add(state.slug);
  }

  try {
    for (const wt of await surveyWorktrees(cwd)) {
      if (wt.slug) slugs.add(wt.slug);
    }
  } catch {
    // Not in a repo — the registry alone has to answer.
  }

  return slugs;
}
