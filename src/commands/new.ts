import fs from "node:fs/promises";
import path from "node:path";
import { ContextError, gitRoot, loadContext } from "../core/context.js";
import {
  addWorktree,
  branchExists,
  defaultBaseRef,
  deleteBranch,
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
import { formatBytes } from "../core/seed.js";
import { planSeed, seedDatabases, type SeedPlan, type SeedReport } from "./seed.js";
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
  /** Worktree to copy database contents from. Overrides `[seed] from`. */
  seedFrom?: string;
  /** Never copy, and never ask. */
  noSeed: boolean;
}

/**
 * Create a worktree and leave it running.
 *
 * This exists because the honest version of the workflow is four commands with
 * error handling between them - branch, `git worktree add`, hydrate, `grove up` -
 * and both humans and agents chain those badly. One call, one JSON result, and
 * a half-built worktree is rolled back rather than left behind.
 */
export async function newWorktree(opts: NewOptions): Promise<void> {
  const branch = opts.branch.trim();
  if (!branch) {
    fail({ ok: false, error: "no branch name", hint: "usage: grove new <branch> [--from <ref>]" }, opts.json);
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

  // Before the worktree exists, so a bad --seed-from fails while there is still
  // nothing to roll back, and so the question is asked before the waiting starts.
  const plan = await resolveSeedPlan(here, main, opts);

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
  let seed: SeedReport | null = null;

  try {
    // Establishing identity through the normal path rather than assuming our
    // slugified guess: `loadContext` writes `.wt/state.json`, resolves a
    // collision against sibling worktrees, and registers the result. Every other
    // command reads that file, so it has to exist before we claim success.
    const ctx = await loadContext(dest);
    const config = ctx.config;

    if (!opts.noHydrate && hasHydrateConfig(config.hydrate)) {
      if (!opts.json) console.log(c.dim("hydrating..."));
      hydration = await hydrate(here, dest, config.hydrate, {
        onProgress: (action) => {
          if (opts.json || action.status === "skipped") return;
          const mark = action.status === "applied" ? c.green("ok") : c.red("x");
          console.log(`  ${mark} ${action.kind} ${action.target}`);
        },
      });
      if (!hydration.ok && !opts.json) {
        console.error(c.yellow("warning: some hydration steps failed - see the report below"));
      }
    }

    if (!opts.noUp) {
      // Databases first when there is data to copy, so the copy lands before the
      // application connects. An app that migrates on boot would otherwise race
      // the restore, and the loser is whichever wrote second.
      if (plan) {
        const services = plan.pairs.map((pair) => pair.source.service);
        if (!opts.json) console.log(c.dim(`starting ${services.join(", ")} first, to copy into`));
        await up({
          json: false,
          quiet: true,
          cwd: dest,
          services,
          build: opts.build,
          noDeps: true,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        });
        seed = await seedDatabases({ plan, targetRoot: dest, quiet: opts.json });
        if (!seed.ok && !opts.json) {
          console.error(c.yellow("warning: the data copy did not finish - see the report below"));
        }
      }

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
    await rollback(here, dest, (await readState(dest))?.slug ?? null, reuseBranch ? null : branch);

    // The overwhelmingly common cause, and one the generic message sends people
    // hunting in the wrong place: worktree.toml exists where they are standing
    // but is not committed on the base they branched from, so the new worktree
    // genuinely does not have it. Say that, rather than "run `grove adapt`".
    const uncommittedConfig =
      /No worktree\.toml found/.test((err as Error).message) && (await exists(path.join(here, "worktree.toml")));

    fail(
      {
        ok: false,
        error: `worktree created but setup failed, so it was removed again: ${(err as Error).message}`,
        hint: uncommittedConfig
          ? `worktree.toml exists here but is not on \`${from ?? branch}\`, so the new worktree did ` +
            `not get it. Commit it (and merge it to the branch you branch from), or use --from <ref>.`
          : "fix the cause and re-run, or pass --no-hydrate --no-up to create it bare",
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
    seed,
    manifest,
  };

  if (opts.json) {
    printJson(payload);
  } else {
    console.log();
    if (seed) {
      for (const db of seed.databases) {
        if (db.copied) continue;
        console.error(c.yellow(`  x ${db.service}: ${db.error ?? "not copied"}`));
        for (const line of db.logs ?? []) console.error(c.dim(`    ${line}`));
      }
    }
    if (manifest) printManifest(manifest);
    else console.log(`${c.green("ok")} ${c.bold(payload.worktree.slug)} created at ${dest}`);
    console.log(c.dim(`  cd ${dest}`));
  }

  if (!payload.ok) process.exitCode = 1;
}

/**
 * Decide whether to copy database contents into the new worktree, and from where.
 *
 * Three ways in, in order of authority: `--seed-from`, `[seed] from` in the
 * config, and finally asking - but only a human, at a terminal. An agent runs
 * `grove new --json` and cannot answer a prompt, so for it the absence of a
 * configured source means "do not copy" rather than a hang.
 */
async function resolveSeedPlan(repo: string, main: string, opts: NewOptions): Promise<SeedPlan | null> {
  if (opts.noSeed || opts.noUp) return null;

  // A repo with no config at all fails later, with a better message than
  // anything this step could produce.
  const configured = await loadContext(repo)
    .then((ctx) => ctx.config.seed.from)
    .catch(() => null);

  const selector = opts.seedFrom ?? configured;
  const interactive = !opts.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!selector && !interactive) return null;

  let plan: SeedPlan | null = null;
  try {
    plan = await planSeed(selector ?? main, repo);
  } catch (err) {
    // Asked for by name and not found is an error. Falling back to the main
    // worktree and finding nothing usable is not.
    if (selector) {
      fail(
        {
          ok: false,
          error: `cannot copy data from "${selector}": ${(err as Error).message}`,
          hint: "pass --no-seed to create the worktree without copying",
        },
        opts.json,
      );
    }
    return null;
  }

  if (!plan || selector) return plan;
  return (await confirmSeed(plan)) ? plan : null;
}

/**
 * Offer the copy, with the two facts needed to answer.
 *
 * How big it is, because that is what the wait will be: the transfer dominates
 * the time `grove new` takes, and a database of any size turns a ten-second
 * command into a multi-minute one. And that declining is safe, because a stack
 * that seeds itself from the repo needs none of this.
 */
async function confirmSeed(plan: SeedPlan): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");

  const what = plan.pairs
    .map((pair) => `${pair.source.service} ${c.dim(`(${formatBytes(pair.size.bytes)})`)}`)
    .join(", ");

  console.log();
  console.log(`${c.bold(plan.sourceLabel)} has data worth copying: ${what}`);
  console.log(c.dim("The new worktree would start from the same data instead of an empty database."));
  console.log(c.dim("The copy is what dominates how long this takes - expect minutes on a large one."));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Copy it? ${c.dim("[y/N]")} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Undo everything this command established, in reverse.
 *
 * `grove gc` would eventually reclaim the leases and the registry entry - a slug
 * whose worktree is gone is exactly what it looks for - but leaving them for it
 * means the next `grove new` on the same branch gets a different port for no
 * reason, and `grove ls` shows a worktree that is not there.
 */
async function rollback(
  repo: string,
  dest: string,
  slug: string | null,
  /** Only set when this invocation created it - never delete a pre-existing branch. */
  branch: string | null,
): Promise<void> {
  try {
    await removeWorktree(repo, dest, true);
  } catch {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  }
  await unregister(dest).catch(() => {});
  if (slug) await releaseLeases(slug).catch(() => {});

  // `git worktree add -b` created the branch, so rolling back has to drop it
  // too. Leaving it behind makes the obvious retry do something *different* and
  // worse: the branch now exists, so the second run checks it out instead of
  // creating it, inheriting whatever the first run based it on - and the error
  // it then reports is about the consequence, not the cause.
  if (branch) await deleteBranch(repo, branch, true).catch(() => {});
}

/** Shared by `grove hydrate`, which re-runs the same logic on an existing worktree. */
export async function hydrateSource(dest: string): Promise<string> {
  const main = await mainWorktree(dest);
  if (path.resolve(main) === path.resolve(dest)) {
    throw new ContextError(
      "This is the main worktree, so there is nothing to hydrate from.",
      "Run `grove hydrate` from a secondary worktree.",
    );
  }
  return main;
}
