import { compose } from "../core/compose.js";
import { loadContext, resolveSelection } from "../core/context.js";
import { fail } from "../core/output.js";
import { leaseHostPorts } from "./up.js";

export interface LogsOptions {
  json: boolean;
  services: string[];
  tail: number;
  follow: boolean;
}

export async function logs(opts: LogsOptions): Promise<void> {
  const ctx = await loadContext();
  await leaseHostPorts(ctx);

  const selection = opts.services.length > 0 ? resolveSelection(ctx, opts.services) : [];
  const args = ["logs", "--no-color", "--tail", String(opts.tail)];
  if (opts.follow) args.push("--follow");
  args.push(...selection);

  if (opts.json) {
    const { stdout, stderr } = await compose(ctx, args);
    const lines = (stdout + stderr).split("\n").map((l) => l.trimEnd()).filter(Boolean);
    // Report the services actually covered, not `[]` — an empty selector means
    // "all", and echoing the empty list back reads as "none".
    const covered = selection.length > 0 ? selection : ctx.config.services.map((s) => s.name);
    console.log(JSON.stringify({ ok: true, services: covered, lines }, null, 2));
    return;
  }

  const { code } = await compose(ctx, args, true);
  if (code !== 0) {
    fail({ ok: false, error: `docker compose logs failed (exit ${code})` }, false);
  }
}
