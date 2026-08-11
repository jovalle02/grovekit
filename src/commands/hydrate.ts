import path from "node:path";
import { loadConfig } from "../core/config.js";
import { ContextError, gitRoot } from "../core/context.js";
import { hasHydrateConfig, hydrate as runHydrate } from "../core/hydrate.js";
import { c, fail, printJson } from "../core/output.js";
import { hydrateSource } from "./new.js";

export interface HydrateOptions {
  json: boolean;
  /** Worktree to copy from. Defaults to the main worktree. */
  from?: string;
  dryRun: boolean;
  force: boolean;
  run: boolean;
}

/**
 * Re-run hydration on an existing worktree.
 *
 * Separate from `wt new` because the need recurs: a `.env` gains a key, a branch
 * changes its lockfile, or a worktree was created by hand with `git worktree add`
 * and arrived broken.
 */
export async function hydrateCommand(opts: HydrateOptions): Promise<void> {
  const dest = await gitRoot();
  const config = await loadConfig(dest);

  if (!hasHydrateConfig(config.hydrate)) {
    fail(
      {
        ok: false,
        error: "no [hydrate] section in worktree.toml, so there is nothing to do",
        hint: 'add e.g. copy = [".env"], link = ["node_modules"], run = ["npm ci"]',
      },
      opts.json,
    );
  }

  let source: string;
  try {
    source = opts.from ? path.resolve(opts.from) : await hydrateSource(dest);
  } catch (err) {
    if (err instanceof ContextError) {
      fail({ ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, opts.json);
    }
    throw err;
  }

  const result = await runHydrate(source, dest, config.hydrate, {
    dryRun: opts.dryRun,
    force: opts.force,
    run: opts.run,
  });

  if (opts.json) {
    printJson(result);
  } else {
    console.log(c.dim(`from ${source}`));
    for (const action of result.actions) {
      const mark =
        action.status === "applied" ? c.green("✓") : action.status === "failed" ? c.red("✗") : c.dim("·");
      const reason = action.reason ? c.dim(` (${action.reason})`) : "";
      console.log(`${mark} ${action.kind.padEnd(4)} ${action.target}${reason}`);
    }
    if (result.actions.length === 0) console.log(c.dim("nothing matched"));
    if (result.lockfiles.length > 0) {
      console.log(
        c.dim(
          `lockfiles ${result.lockfiles.join(", ")}: ${result.lockfilesMatch ? "identical — safe to link" : "differ — installed instead"}`,
        ),
      );
    }
  }

  if (!result.ok) process.exitCode = 1;
}
