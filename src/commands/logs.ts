import { compose } from "../core/compose.js";
import { loadContext, resolveSelection } from "../core/context.js";
import { fail } from "../core/output.js";
import { tailLog } from "../core/processes.js";
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

  // A host process has no container, so its output is whatever we captured when
  // we started it. Compose knows nothing about it and would report no such
  // service at all.
  const hosts = ctx.config.services.filter(
    (s) => s.runtime === "host" && (selection.length === 0 || selection.includes(s.name)),
  );
  const hostLines: string[] = [];
  for (const svc of hosts) {
    const lines = await tailLog(ctx.root, svc.name, opts.tail);
    for (const line of lines) hostLines.push(`${svc.name}  | ${line}`);
  }
  const composeSelection = selection.filter((name) => !hosts.some((h) => h.name === name));
  if (selection.length > 0 && composeSelection.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, services: selection, lines: hostLines }, null, 2));
    } else {
      for (const line of hostLines) console.log(line);
    }
    return;
  }
  const args = ["logs", "--no-color", "--tail", String(opts.tail)];
  if (opts.follow) args.push("--follow");
  args.push(...selection);

  if (opts.json) {
    const { stdout, stderr } = await compose(ctx, args);
    const lines = (stdout + stderr).split("\n").map((l) => l.trimEnd()).filter(Boolean);
    // Report the services actually covered, not `[]` - an empty selector means
    // "all", and echoing the empty list back reads as "none".
    const covered = selection.length > 0 ? selection : ctx.config.services.map((s) => s.name);
    console.log(JSON.stringify({ ok: true, services: covered, lines }, null, 2));
    return;
  }

  for (const line of hostLines) console.log(line);
  const { code } = await compose(ctx, args, true);
  if (code !== 0) {
    fail({ ok: false, error: `docker compose logs failed (exit ${code})` }, false);
  }
}
