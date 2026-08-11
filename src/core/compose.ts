import path from "node:path";
import { exec, execOrThrow, type ExecResult } from "./exec.js";
import { envKey } from "./naming.js";
import type { Context } from "./context.js";

export interface ComposePs {
  service: string;
  name: string;
  /** Compose container state: running | exited | created | restarting | ... */
  state: string;
  /** Docker healthcheck verdict, when the image defines one. Often empty. */
  health: string;
}

/** Environment the compose files interpolate against. */
export function composeEnv(ctx: Context): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WT_NAME: ctx.slug,
    WT_DOMAIN: ctx.config.domain,
    WT_PROXY_NETWORK: ctx.config.proxy.network,
    WT_PROXY_PORT: String(ctx.config.proxy.port),
  };
  for (const [service, port] of Object.entries(ctx.leases)) {
    env[`WT_PORT_${envKey(service)}`] = String(port);
  }
  return env;
}

export function composeArgs(ctx: Context, ...rest: string[]): string[] {
  const files = ctx.config.project.compose.flatMap((f) => ["-f", path.resolve(ctx.root, f)]);
  return ["compose", ...files, "-p", ctx.slug, ...rest];
}

/**
 * True when this worktree has anything for Compose to do.
 *
 * A repo whose services are all `host` has no compose file at all, and running
 * `docker compose` with no `-f` would make it search the working directory and
 * act on whatever it happened to find there.
 */
export function hasCompose(ctx: Context): boolean {
  return ctx.config.project.compose.length > 0;
}

export function compose(ctx: Context, args: string[], inherit = false): Promise<ExecResult> {
  if (!hasCompose(ctx)) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  return exec("docker", composeArgs(ctx, ...args), {
    cwd: ctx.root,
    env: composeEnv(ctx),
    inherit,
  });
}

export function composeOrThrow(ctx: Context, args: string[], inherit = false): Promise<ExecResult> {
  return execOrThrow("docker", composeArgs(ctx, ...args), {
    cwd: ctx.root,
    env: composeEnv(ctx),
    inherit,
  });
}

/**
 * What Compose actually has containers for.
 *
 * Scope is always derived from here rather than from the command line, so that
 * dependency expansion (`up api` also starting `db`), incremental adds
 * (`up cache` later) and manual `docker compose` use all produce a manifest that
 * describes reality instead of intent.
 */
export async function composePs(ctx: Context): Promise<ComposePs[]> {
  const { code, stdout } = await compose(ctx, ["ps", "--all", "--format", "json"]);
  if (code !== 0) return [];

  const text = stdout.trim();
  if (!text) return [];

  // Compose emits NDJSON on some versions and a JSON array on others.
  let rows: unknown[];
  try {
    rows = text.startsWith("[")
      ? (JSON.parse(text) as unknown[])
      : text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as unknown);
  } catch {
    return [];
  }

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      service: String(r.Service ?? ""),
      name: String(r.Name ?? ""),
      state: String(r.State ?? ""),
      health: String(r.Health ?? ""),
    };
  });
}

export async function composeLogs(ctx: Context, service: string, tail: number): Promise<string[]> {
  const { stdout, stderr } = await compose(ctx, [
    "logs",
    "--no-color",
    "--tail",
    String(tail),
    service,
  ]);
  return (stdout + stderr)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-tail);
}

/** `docker compose config` — resolves and validates the merged file set. */
export async function composeConfig(ctx: Context): Promise<ExecResult> {
  return compose(ctx, ["config", "--format", "json"]);
}
