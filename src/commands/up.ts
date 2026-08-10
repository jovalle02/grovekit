import { compose, composePs } from "../core/compose.js";
import { loadContext, resolveSelection, type Context } from "../core/context.js";
import { buildRuntime, waitReady } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { c, fail, printJson, printManifest } from "../core/output.js";
import { leasePort } from "../core/ports.js";
import { ensureProxy } from "../core/proxy.js";
import { envKey } from "../core/naming.js";

export interface UpOptions {
  json: boolean;
  services: string[];
  build: boolean;
  noDeps: boolean;
  timeoutMs?: number;
}

/**
 * Idempotent. Re-running against a live stack is a no-op plus a fresh manifest,
 * which is what makes it safe for an agent to call whenever it is unsure.
 */
export async function up(opts: UpOptions): Promise<void> {
  const ctx = await loadContext();
  const selection = resolveSelection(ctx, opts.services);

  await ensureProxy(ctx.config);
  await leaseHostPorts(ctx);

  const args = ["up", "-d", "--remove-orphans"];
  if (opts.build) args.push("--build");
  if (opts.noDeps) args.push("--no-deps");
  // Empty selection means "everything"; passing no names is how Compose says that.
  if (opts.services.length > 0) args.push(...selection);

  const result = await compose(ctx, args, !opts.json);
  if (result.code !== 0) {
    fail(
      {
        ok: false,
        error: `docker compose up failed (exit ${result.code})`,
        hint: "run `wt doctor` to check the environment, or `docker compose config` to inspect the merged file",
        logs: (result.stderr || result.stdout).trim().split("\n").slice(-20),
      },
      opts.json,
    );
  }

  const runtime = buildRuntime(ctx, await composePs(ctx));

  if (!opts.json) {
    const pending = runtime.filter((s) => s.status === "starting").map((s) => s.config.name);
    if (pending.length > 0) console.log(c.dim(`waiting for ${pending.join(", ")}…`));
  }

  const { ok } = await waitReady(ctx, runtime, opts.timeoutMs ?? ctx.config.healthTimeoutMs);
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime));

  if (opts.json) printJson(manifest);
  else printManifest(manifest);

  // Non-zero on failure: agents and CI branch on this, not on parsing the output.
  if (!ok) process.exitCode = 1;
}

/** Only services declaring `host_port` consume a lease. */
export async function leaseHostPorts(ctx: Context): Promise<void> {
  for (const svc of ctx.config.services) {
    if (!svc.hostPort) continue;
    ctx.leases[svc.name] = await leasePort(`${ctx.slug}/${svc.name}`);
  }
}

export function leaseEnvSummary(ctx: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [service, port] of Object.entries(ctx.leases)) {
    out[`WT_PORT_${envKey(service)}`] = String(port);
  }
  return out;
}
