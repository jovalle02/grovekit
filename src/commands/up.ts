import { compose, composePs } from "../core/compose.js";
import { loadContext, resolveSelection, type Context } from "../core/context.js";
import { buildEnv } from "../core/env.js";
import { buildRuntime, probeHosts, waitReady, type RuntimeService } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { c, fail, printJson, printManifest } from "../core/output.js";
import { leasePort } from "../core/ports.js";
import { ensureProxy } from "../core/proxy.js";
import { renderFiles } from "../core/render.js";
import { envKey } from "../core/naming.js";
import type { Manifest } from "../types.js";

export interface UpOptions {
  json: boolean;
  services: string[];
  build: boolean;
  noDeps: boolean;
  timeoutMs?: number;
  /** Worktree to act on. Defaults to the process cwd; `wt new` passes the new one. */
  cwd?: string;
  /** Return the manifest instead of printing it. Used when `up` is a sub-step. */
  quiet?: boolean;
}

/**
 * Idempotent. Re-running against a live stack is a no-op plus a fresh manifest,
 * which is what makes it safe for an agent to call whenever it is unsure.
 */
export async function up(opts: UpOptions): Promise<Manifest> {
  const ctx = await loadContext(opts.cwd);
  const selection = resolveSelection(ctx, opts.services);

  await ensureProxy(ctx.config);
  await leaseHostPorts(ctx);

  // What was already down before we touched anything. Needed below to tell "you
  // stopped this earlier" from "this just failed to start".
  const preStopped = new Set(
    (await composePs(ctx)).filter((p) => p.state !== "running").map((p) => p.service),
  );

  const args = ["up", "-d", "--remove-orphans"];
  if (opts.build) args.push("--build");
  if (opts.noDeps) args.push("--no-deps");
  // Empty selection means "everything"; passing no names is how Compose says that.
  if (opts.services.length > 0) args.push(...selection);

  const result = await compose(ctx, args, !opts.json && !opts.quiet);
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
  markFailedToStart(runtime, preStopped, opts.services.length > 0 ? new Set(selection) : null);

  if (!opts.json && !opts.quiet) {
    const pending = runtime.filter((s) => s.status === "starting").map((s) => s.config.name);
    if (pending.length > 0) console.log(c.dim(`waiting for ${pending.join(", ")}…`));
  }

  const { ok } = await waitReady(ctx, runtime, opts.timeoutMs ?? ctx.config.healthTimeoutMs);
  await probeHosts(ctx, runtime);

  const rendered = await applyRender(ctx, runtime, !opts.json && !opts.quiet);
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime, rendered));

  // Non-zero on failure: agents and CI branch on this, not on parsing the output.
  if (!ok) process.exitCode = 1;

  if (opts.quiet) return manifest;
  if (opts.json) printJson(manifest);
  else printManifest(manifest);
  return manifest;
}

/**
 * A container that exists but is not running, right after we asked Compose to
 * start it, has failed to start — it is not "stopped".
 *
 * Without this a service that crashes fast enough to be gone before the first
 * `compose ps` is never watched by `waitReady`: it is not `starting`, so it is
 * never probed, never marked unhealthy, and never gets its logs attached. The
 * stack then reports `starting` with exit 0 — success, for a broken stack.
 *
 * Services deliberately left down are exempt, which is why the caller has to say
 * both what it asked for and what was already stopped beforehand.
 */
export function markFailedToStart(
  runtime: RuntimeService[],
  preStopped: ReadonlySet<string>,
  requested: ReadonlySet<string> | null,
): void {
  for (const svc of runtime) {
    if (svc.status !== "stopped") continue;
    const name = svc.config.name;
    // `requested === null` means "everything", so everything was asked for.
    const askedFor = requested === null || requested.has(name);
    if (askedFor || !preStopped.has(name)) svc.status = "starting";
  }
}

/**
 * Write the `[render]` files and report which ones landed.
 *
 * Shared by `up` and `status` so that a worktree's generated config is refreshed
 * by any command that looks at it, not only by the one that starts things. A
 * host process is usually launched by the developer directly — `the run command`,
 * `pnpm dev` — and by then the last `wt` command they ran may well have been
 * `wt status`.
 *
 * A failed render is reported and does not abort: the containers are already up,
 * and taking the stack down over a typo in a template would be a worse outcome
 * than a loud warning.
 */
export async function applyRender(
  ctx: Context,
  runtime: RuntimeService[],
  report: boolean,
): Promise<string[]> {
  if (Object.keys(ctx.config.render).length === 0) return [];

  const env = buildEnv(ctx, buildManifest(ctx, runtime));
  const results = await renderFiles(ctx.root, ctx.config.render, env);

  if (report) {
    for (const result of results) {
      if (result.status === "written") console.log(`${c.green("✓")} rendered ${result.file}`);
      else if (result.status === "failed") {
        console.error(c.red(`✗ could not render ${result.file}: ${result.reason}`));
      }
    }
  }

  return results.filter((r) => r.status !== "failed").map((r) => r.file);
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
