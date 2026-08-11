import { spawn } from "node:child_process";
import { composePs } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { buildEnv } from "../core/env.js";
import { buildRuntime, probeOnce } from "../core/health.js";
import { buildManifest } from "../core/manifest.js";
import { c, fail } from "../core/output.js";
import { leaseHostPorts } from "./up.js";


export interface RunOptions {
  json: boolean;
  argv: string[];
  /** Skip the readiness gate. Escape hatch for commands that don't need the stack. */
  force: boolean;
}

export async function run(opts: RunOptions): Promise<void> {
  if (opts.argv.length === 0) {
    fail({ ok: false, error: "nothing to run", hint: "usage: wt run <command…>" }, opts.json);
  }

  const ctx = await loadContext();
  await leaseHostPorts(ctx);

  // Compute fresh rather than trusting the manifest: it may be stale after a
  // crash, and running tests against a stack that isn't there wastes more time
  // than one `compose ps` costs.
  const runtime = buildRuntime(ctx, await composePs(ctx));
  await probeOnce(ctx, runtime);
  const manifest = buildManifest(ctx, runtime);

  if (!opts.force && manifest.status !== "ready") {
    const broken = manifest.services.filter((s) => s.status === "unhealthy").map((s) => s.name);
    const stopped = manifest.services
      .filter((s) => s.status === "stopped" || s.status === "not-started")
      .map((s) => s.name);

    fail(
      {
        ok: false,
        error: `stack is ${manifest.status}, refusing to run`,
        hint:
          broken.length > 0
            ? `unhealthy: ${broken.join(", ")} — try \`wt logs ${broken[0]}\``
            : `run \`wt up\` first${stopped.length ? ` (not running: ${stopped.join(", ")})` : ""}`,
        ...(broken[0] ? { service: broken[0] } : {}),
      },
      opts.json,
    );
  }

  const env = buildEnv(ctx, manifest);

  // A command pointed at BASE_URL will fail confusingly if that service was left
  // out of scope. Warn rather than block — API-only runs are legitimate.
  const primary = manifest.services.find((s) => s.url && s.url === manifest.baseUrl);
  if (primary && primary.status !== "ready" && !opts.json) {
    console.error(
      c.yellow(`warning: BASE_URL points at \`${primary.name}\`, which is ${primary.status}`),
    );
  }

  // `shell: true` so Windows `.cmd` shims (npm, pnpm, yarn) resolve, and so
  // `wt run "a && b"` behaves the way people expect. That means we hand the shell
  // one string, so each argument has to be re-quoted or `-e 'inline script'`
  // arrives as separate words.
  const command = opts.argv.map(quoteForShell).join(" ");
  const child = spawn(command, {
    cwd: ctx.root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  });

  child.on("error", (err) => {
    fail({ ok: false, error: `could not start \`${command}\`: ${err.message}` }, opts.json);
  });

  // Exit-code passthrough is non-negotiable: without it a failing e2e suite
  // reads as a pass to every caller.
  child.on("close", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

/**
 * Re-quote a single argument for the platform shell.
 *
 * cmd.exe wants double quotes with `"` doubled; POSIX shells want single quotes
 * with `'` broken out. Tokens that need no quoting are passed through so simple
 * invocations stay readable in error messages.
 */
export function quoteForShell(arg: string): string {
  if (process.platform === "win32") {
    if (arg === "" ) return '""';
    if (!/[\s&|<>^()"%!,;]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
  }
  if (arg === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
