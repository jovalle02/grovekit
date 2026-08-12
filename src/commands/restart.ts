import { loadContext, resolveSelection } from "../core/context.js";
import { c } from "../core/output.js";
import { stopProcess } from "../core/processes.js";
import { compose } from "../core/compose.js";
import { down } from "./down.js";
import { up } from "./up.js";

export interface RestartOptions {
  json: boolean;
  services: string[];
  build: boolean;
  timeoutMs?: number;
}

/**
 * Stop and start again - scoped to what you name.
 *
 * This exists because its absence was being worked around badly. With only
 * `down` and `up`, restarting one service meant taking the whole stack down and
 * bringing it back, which is slow and looks indiscriminate. `down` has always
 * accepted service names, but nothing said so, so nobody used it that way.
 *
 * Scoped to this worktree, like everything else: containers are addressed by the
 * Compose project name, which *is* the slug, and host processes by this
 * worktree's own `.wt/processes.json`. Neither can reach another worktree.
 */
export async function restart(opts: RestartOptions): Promise<void> {
  const ctx = await loadContext();
  const selection = opts.services.length > 0 ? resolveSelection(ctx, opts.services) : [];
  const what = selection.length > 0 ? selection.join(", ") : "the whole stack";

  if (!opts.json) console.log(c.dim(`restarting ${what} in ${ctx.slug}...`));

  // Host processes have to be stopped explicitly: `up` will not replace a live
  // one unless its generated config changed, which is the correct default and
  // exactly what we are overriding here.
  const wanted = selection.length > 0 ? new Set(selection) : null;
  for (const svc of ctx.config.services) {
    if (svc.runtime !== "host") continue;
    if (wanted && !wanted.has(svc.name)) continue;
    await stopProcess(ctx.root, svc.name);
  }

  // Containers: `stop` rather than `down`, so volumes, networks and data survive
  // - a restart is not a teardown.
  if (selection.length > 0) await compose(ctx, ["stop", ...selection], !opts.json);
  else await compose(ctx, ["stop"], !opts.json);

  await up({
    json: opts.json,
    services: opts.services,
    build: opts.build,
    noDeps: false,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

// `down` is re-exported so the two verbs stay visibly adjacent: restart is
// exactly down-then-up, and any divergence between them is a bug.
export { down };
