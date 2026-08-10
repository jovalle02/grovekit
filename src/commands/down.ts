import { compose, composePs } from "../core/compose.js";
import { loadContext, resolveSelection } from "../core/context.js";
import { buildRuntime } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { c, fail, printJson } from "../core/output.js";
import { leaseHostPorts } from "./up.js";

export interface DownOptions {
  json: boolean;
  services: string[];
  /** Remove containers and networks as well as stopping them. Volumes are kept. */
  remove: boolean;
}

/**
 * Non-destructive by design: volumes, databases, port leases and the worktree
 * all survive. Only `wt rm` deletes data, and only when asked.
 */
export async function down(opts: DownOptions): Promise<void> {
  const ctx = await loadContext();
  await leaseHostPorts(ctx);

  const selection = opts.services.length > 0 ? resolveSelection(ctx, opts.services) : [];

  const args = selection.length > 0
    ? ["stop", ...selection]
    : opts.remove
      ? ["down", "--remove-orphans"]
      : ["stop"];

  const result = await compose(ctx, args, !opts.json);
  if (result.code !== 0) {
    fail(
      {
        ok: false,
        error: `docker compose ${args[0]} failed (exit ${result.code})`,
        logs: (result.stderr || result.stdout).trim().split("\n").slice(-20),
      },
      opts.json,
    );
  }

  const runtime = buildRuntime(ctx, await composePs(ctx));
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime));

  if (opts.json) {
    printJson(manifest);
  } else {
    const what = selection.length > 0 ? selection.join(", ") : "stack";
    console.log(`${c.green("✓")} ${what} stopped ${c.dim("(volumes and data kept — `wt up` to resume)")}`);
  }
}
