import fs from "node:fs/promises";
import path from "node:path";
import { ContextError, gitRoot, loadContext } from "../core/context.js";
import {
  addWorktree,
  branchExists,
  defaultBaseRef,
  mainWorktree,
  refExists,
  removeWorktree,
} from "../core/git.js";
import { exists } from "../core/glob.js";
import { hasHydrateConfig, hydrate, type HydrateResult } from "../core/hydrate.js";
import { slugify } from "../core/naming.js";
import { c, fail, printJson, printManifest } from "../core/output.js";
import { releaseLeases } from "../core/ports.js";
import { unregister } from "../core/registry.js";
import { readState } from "../core/worktrees.js";
import { up } from "./up.js";
import type { Manifest } from "../types.js";

export interface NewOptions {
  json: boolean;
  branch: string;
  /** Base ref for a new branch. Ignored when the branch already exists. */
  from?: string;
  /** Explicit destination directory. Default is a sibling of the main worktree. */
  path?: string;
  noHydrate: boolean;
  noUp: boolean;
  build: boolean;
  services: string[];
  timeoutMs?: number;
}

/**
 * Create a worktree and leave it running.
 *
 * This exists because the honest version of the workflow is four commands with
 * error handling between them — branch, `git worktree add`, hydrate, `wt up` —
 * and both humans and agents chain those badly. One call, one JSON result, and
 * a half-built worktree is rolled back rather than left behind.
 */
export async function newWorktree(opts: NewOptions): Promise<void> {
  const branch = opts.branch.trim();
  if (!branch) {
    fail({ ok: false, error: "no branch name", hint: "usage: wt new <branch> [--from <ref>]" }, opts.json);
  }

  const here = await gitRoot();
  const main = await mainWorktree(here);
  const slug = slugify(branch);

  const dest = opts.path
    ? path.resolve(opts.path)
    : path.join(path.dirname(main), `${path.basename(main)}-${slug}`);

  if (await exists(dest)) {
    fail(
      { ok: false, error: `${dest} already exists`, hint: "pass --path <dir> to choose another location" },
      opts.json,
    );
  }

  const reuseBranch = await branchExists(here, branch);
  let from: string | null = null;
  if (!reuseBranch) {
    from = opts.from ?? (await defaultBaseRef(here));
    if (!(await refExists(here, from))) {
      fail({ ok: false, error: `base ref "${from}" does not exist` }, opts.json);
    }
  } else if (opts.from) {
    fail(
      {
        ok: false,
        error: `branch "${branch}" already exists, so --from ${opts.from} would be ignored`,
        hint: "drop --from to check out the existing branch, or pick a new branch name",
      },
      opts.json,
    );
  }

  if (!opts.json) {
    console.log(
      c.dim(reuseBranch ? `checking out ${branch} in ${dest}` : `creating ${branch} from ${from} in ${dest}`),
    );
  }

  try {
    await addWorktree(here, dest, branch, from);
  } catch (err) {
    fail({ ok: false, error: `git worktree add failed: ${(err as Error).message}` }, opts.json);
  }

  // From here on the worktree exists on disk. Any failure rolls it back, because
  // a half-created worktree is worse than none: it holds the branch checked out
  // and blocks a retry with the same name.
  let hydration: HydrateResult | null = null;
  let manifest: Manifest | null = null;

  try {
    // Establishing identity through the normal path rather than assuming our
    // slugified guess: `loadContext` writes `.wt/state.json`, resolves a
    // collision against sibling worktrees, and registers the result. Every other
    // command reads that file, so it has to exist before we claim success.
    const ctx = await loadContext(dest);
    const config = ctx.config;

    if (!opts.noHydrate && hasHydrateConfig(config.hydrate)) {
      if (!opts.json) console.log(c.dim("hydrating…"));
      hydration = await hydrate(here, dest, config.hydrate, {
        onProgress: (action) => {
          if (opts.json || action.status === "skipped") return;
          const mark = action.status === "applied" ? c.green("✓") : c.red("✗");
          console.log(`  ${mark} ${action.kind} ${action.target}`);
        },
      });
      if (!hydration.ok && !opts.json) {
        console.error(c.yellow("warning: some hydration steps failed — see the report below"));
      }
    }

    if (!opts.noUp) {
      manifest = await up({
        json: false,
        quiet: true,
        cwd: dest,
        services: opts.services,
        build: opts.build,
        noDeps: false,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
    }
  } catch (err) {
    await rollback(here, dest, (await readState(dest))?.slug ?? null);
    fail(
      {
        ok: false,
        error: `worktree created but setup failed, so it was removed again: ${(err as Error).message}`,
        hint: "fix the cause and re-run, or pass --no-hydrate --no-up to create it bare",
      },
      opts.json,
    );
  }

  const state = await readState(dest);
  const payload = {
    ok: manifest === null || manifest.status === "ready",
    worktree: {
      slug: state?.slug ?? slug,
      branch,
      root: dest,
      createdBranch: !reuseBranch,
      base: from,
    },
    hydrate: hydration,
    manifest,
  };

  if (opts.json) {
    printJson(payload);
  } else {
    console.log();
    if (manifest) printManifest(manifest);
    else console.log(`${c.green("✓")} ${c.bold(payload.worktree.slug)} created at ${dest}`);
    console.log(c.dim(`  cd ${dest}`));
  }

  if (!payload.ok) process.exitCode = 1;
}

/**
 * Undo everything this command established, in reverse.
 *
 * `wt gc` would eventually reclaim the leases and the registry entry — a slug
 * whose worktree is gone is exactly what it looks for — but leaving them for it
 * means the next `wt new` on the same branch gets a different port for no
 * reason, and `wt ls` shows a worktree that is not there.
 */
async function rollback(repo: string, dest: string, slug: string | null): Promise<void> {
  try {
    await removeWorktree(repo, dest, true);
  } catch {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  }
  await unregister(dest).catch(() => {});
  if (slug) await releaseLeases(slug).catch(() => {});
}

/** Shared by `wt hydrate`, which re-runs the same logic on an existing worktree. */
export async function hydrateSource(dest: string): Promise<string> {
  const main = await mainWorktree(dest);
  if (path.resolve(main) === path.resolve(dest)) {
    throw new ContextError(
      "This is the main worktree, so there is nothing to hydrate from.",
      "Run `wt hydrate` from a secondary worktree.",
    );
  }
  return main;
}
