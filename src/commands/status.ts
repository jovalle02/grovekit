import { composePs } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { buildRuntime, probeOnce } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { printJson, printManifest } from "../core/output.js";
import { buildEnv } from "../core/env.js";
import { applyRender, leaseHostPorts } from "./up.js";

export interface StatusOptions {
  json: boolean;
  /** Print the injected environment instead of the service table. */
  env: boolean;
}

/**
 * Read-only and cheap. Safe for an agent to call at any point, including before
 * anything has ever been started.
 */
export async function status(opts: StatusOptions): Promise<void> {
  const ctx = await loadContext();
  await leaseHostPorts(ctx);

  const runtime = buildRuntime(ctx, await composePs(ctx));
  // Without this every running service would report `starting` forever: Compose
  // only tells us the container exists, not that the app inside answers.
  await probeOnce(ctx, runtime);

  // Refresh generated config here too: a host process is launched by the
  // developer directly, and `wt status` is often the last thing run before that.
  const rendered = await applyRender(ctx, runtime, !opts.json);
  const manifest = buildManifest(ctx, runtime, rendered);

  // Refresh the on-disk manifest so a crashed run can't leave a stale one behind.
  await writeManifest(ctx, manifest);

  if (opts.env) {
    const env = buildEnv(ctx, manifest);
    if (opts.json) {
      printJson(env);
    } else {
      for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
    }
    return;
  }

  if (opts.json) printJson(manifest);
  else printManifest(manifest);
}
