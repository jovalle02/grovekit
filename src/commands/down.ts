import { compose, composePs } from "../core/compose.js";
import { loadContext, resolveSelection } from "../core/context.js";
import { buildRuntime, probeHosts } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { c, fail, printJson } from "../core/output.js";
import { stopProcess } from "../core/processes.js";
import { leaseHostPorts } from "./up.js";

export interface DownOptions {
  json: boolean;
  services: string[];
  /** Remove containers and networks as well as stopping them. Volumes are kept. */
  remove: boolean;
}

/**
 * Non-destructive by design: volumes, databases, port leases and the worktree
 * all survive. Only `grove rm` deletes data, and only when asked.
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

  // Host processes first. Pulling the containers out from under one that depends
  // on them fills its log with connection errors for no reason, and `down` is
  // meant to be the quiet, reversible command.
  const wanted = selection.length > 0 ? new Set(selection) : null;
  for (const svc of ctx.config.services) {
    if (svc.runtime !== "host") continue;
    if (wanted && !wanted.has(svc.name)) continue;
    if (await stopProcess(ctx.root, svc.name) && !opts.json) {
      console.log(`${c.green("✓")} stopped ${svc.name}`);
    }
  }

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
  await probeHosts(ctx, runtime);
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime));

  if (opts.json) {
    printJson(manifest);
  } else {
    // Name the worktree, not just the action. With several stacks running, "stack
    // stopped" reads as "everything stopped" — and the fix for that suspicion is
    // to say whose stack it was.
    const what = selection.length > 0 ? selection.join(", ") : "all services";
    console.log(`${c.green("✓")} stopped ${what} in ${c.bold(ctx.slug)}`);
    console.log(c.dim(`  volumes, data and port leases kept — \`grove up\` to resume`));
    console.log(c.dim(`  other worktrees are untouched; \`grove ls --all\` to confirm`));
  }
}
