import path from "node:path";
import { compose } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { removeProject } from "../core/docker.js";
import { deleteBranch, isDirty, mainWorktree, pruneWorktrees, removeWorktree } from "../core/git.js";
import { c, fail, printJson } from "../core/output.js";
import { releaseLeases } from "../core/ports.js";
import { unregister } from "../core/registry.js";
import { resolveWorktree } from "../core/worktrees.js";
import { leaseHostPorts } from "./up.js";

/**
 * Path containment, done properly.
 *
 * A plain `startsWith` says `app-feature` is inside `app-feat`, so sibling
 * worktrees named after related branches — which is the normal case here —
 * would refuse to be removed. The separator is what makes it a real boundary.
 */
function isInside(child: string, parent: string): boolean {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  const same = process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return process.platform === "win32"
    ? a.toLowerCase().startsWith(prefix.toLowerCase())
    : a.startsWith(prefix);
}

export interface RmOptions {
  json: boolean;
  target: string;
  /** Remove even when the worktree has uncommitted changes. */
  force: boolean;
  deleteBranch: boolean;
  /** Keep named volumes — the databases — behind. */
  keepVolumes: boolean;
}

/**
 * The only destructive command. Everything it deletes is named in the result, and
 * nothing is deleted until every guard has passed.
 */
export async function rm(opts: RmOptions): Promise<void> {
  if (!opts.target) {
    fail(
      { ok: false, error: "no worktree given", hint: "usage: wt rm <slug|branch|path>" },
      opts.json,
    );
  }

  const target = await resolveWorktree(opts.target);
  const repo = await mainWorktree(process.cwd());

  if (target.main) {
    fail(
      {
        ok: false,
        error: `"${opts.target}" is the main worktree and cannot be removed`,
        hint: "wt rm removes secondary worktrees only",
      },
      opts.json,
    );
  }

  // Removing the directory you are standing in fails outright on Windows and
  // leaves the shell in a deleted cwd on POSIX. Refuse rather than half-succeed.
  if (isInside(process.cwd(), target.path)) {
    fail(
      {
        ok: false,
        error: "refusing to remove the worktree you are currently inside",
        hint: `cd ${repo} first`,
      },
      opts.json,
    );
  }

  if (!opts.force && (await isDirty(target.path))) {
    fail(
      {
        ok: false,
        error: `${target.path} has uncommitted changes`,
        hint: "commit or stash them, or pass --force to discard them",
      },
      opts.json,
    );
  }

  const slug = target.slug;
  let removed = { containers: 0, volumes: 0, networks: 0 };

  if (slug) {
    // Count first: after teardown there is nothing left to count, and a report
    // that says "0 containers" for a stack that was running reads as a bug.
    removed = await removeProject(slug, { volumes: !opts.keepVolumes, dryRun: true });

    // Prefer Compose — it knows about orphans and anonymous volumes. Fall back to
    // the label sweep when the config no longer loads, which happens whenever the
    // branch predates worktree.toml.
    try {
      const ctx = await loadContext(target.path);
      await leaseHostPorts(ctx);
      const args = ["down", "--remove-orphans"];
      if (!opts.keepVolumes) args.push("--volumes");
      await compose(ctx, args, !opts.json);
    } catch {
      /* fall through to the label sweep */
    }
    await removeProject(slug, { volumes: !opts.keepVolumes });
  }

  const leases = slug ? await releaseLeases(slug) : [];

  try {
    await removeWorktree(repo, target.path, opts.force);
  } catch (err) {
    fail(
      {
        ok: false,
        error: `git worktree remove failed: ${(err as Error).message}`,
        hint: "the stack has already been torn down; re-run with --force to drop the directory",
      },
      opts.json,
    );
  }
  await pruneWorktrees(repo);
  await unregister(target.path);

  let branchDeleted = false;
  if (opts.deleteBranch && target.branch && !target.branch.startsWith("(")) {
    branchDeleted = await deleteBranch(repo, target.branch, opts.force);
  }

  const payload = {
    ok: true,
    removed: {
      slug,
      root: target.path,
      branch: target.branch,
      containers: removed.containers,
      volumes: opts.keepVolumes ? 0 : removed.volumes,
      networks: removed.networks,
      leases,
      branchDeleted,
    },
  };

  if (opts.json) {
    printJson(payload);
    return;
  }

  console.log(`${c.green("✓")} removed ${c.bold(slug ?? path.basename(target.path))}`);
  console.log(
    c.dim(
      `  ${removed.containers} containers, ${payload.removed.volumes} volumes, ` +
        `${removed.networks} networks, ${leases.length} port leases` +
        (branchDeleted ? `, branch ${target.branch}` : ""),
    ),
  );
  if (opts.keepVolumes) console.log(c.dim("  volumes kept (--keep-volumes)"));
  if (opts.deleteBranch && !branchDeleted) {
    console.log(c.yellow(`  branch ${target.branch} was not deleted (unmerged? use --force)`));
  }
}
