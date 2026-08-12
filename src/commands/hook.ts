import { compose, composePs } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { buildRuntime, probeOnce } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { printJson } from "../core/output.js";
import { surveyWorktrees } from "../core/worktrees.js";
import { leaseHostPorts } from "./up.js";
import type { Manifest } from "../types.js";

export interface HookOptions {
  json: boolean;
  event: string;
}

export const HOOK_EVENTS = ["session-start", "session-end"] as const;

/** A few ports — enough to recognise a stack, not enough to fill the screen. */
function shortPorts(manifest: Manifest | null): string {
  const addresses = (manifest?.services ?? [])
    .map((svc) => svc.hostAddress)
    .filter((a): a is string => a !== null)
    .map((a) => a.replace(/^localhost:/, ""));
  if (addresses.length === 0) return manifest?.baseUrl ?? "no ports";
  return addresses.slice(0, 3).join(" ") + (addresses.length > 3 ? ` +${addresses.length - 3}` : "");
}

/**
 * Agent lifecycle hooks.
 *
 * The logic lives here rather than in inline shell in `settings.json` so that it
 * is cross-platform, testable, and versioned with the tool instead of frozen into
 * whatever the user's editor wrote once.
 *
 * A hook must never break the session it is attached to: every path exits 0, and
 * a hook that has nothing useful to say says nothing at all.
 */
export async function hook(opts: HookOptions): Promise<void> {
  try {
    if (opts.event === "session-start") await sessionStart(opts);
    else if (opts.event === "session-end") await sessionEnd(opts);
    else if (opts.json) printJson({ ok: false, error: `unknown hook event "${opts.event}"` });
    else console.error(`unknown hook event "${opts.event}" (expected: ${HOOK_EVENTS.join(", ")})`);
  } catch {
    // Silence is the contract. A repo without worktree.toml, a stopped Docker
    // daemon, a detached HEAD — none of them are the session's problem.
  }
}

/**
 * The stronger of the two hooks: there is a turn to render into, the state is
 * actionable, and stdout is injected into the agent's context. Keep it to a few
 * lines — this is prepended to every session in the repo.
 */
async function sessionStart(opts: HookOptions): Promise<void> {
  const ctx = await loadContext();
  if (ctx.config.hooks.onSessionStart === "off") return;

  // Leases have to be resolved before the manifest is built, or every host
  // address is null and the whole point of this hook — telling the session its
  // own ports — reports nothing.
  await leaseHostPorts(ctx);

  const runtime = buildRuntime(ctx, await composePs(ctx));
  await probeOnce(ctx, runtime);
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime));

  const worktrees = await surveyWorktrees().catch(() => []);
  const others = worktrees.filter((w) => w.slug && w.slug !== ctx.slug);

  if (opts.json) {
    printJson({
      ok: true,
      manifest,
      otherWorktrees: others.map((w) => ({ slug: w.slug, branch: w.branch, status: w.manifest?.status ?? "unknown" })),
    });
    return;
  }

  const lines = [`git-grove: worktree \`${ctx.slug}\` (branch ${ctx.branch}), stack ${manifest.status}.`];

  // This worktree's own addresses, spelled out rather than pointed at. It is the
  // single most common thing a session needs, and the most common thing it gets
  // wrong: with several stacks running, a port carried over from another
  // worktree fails in a way that looks like a broken app, not a wrong address.
  const mine = manifest.services.filter((svc) => svc.url ?? svc.hostAddress);
  if (mine.length > 0) {
    lines.push("  Addresses for THIS worktree — use these, never a hardcoded port:");
    for (const svc of mine) {
      const state = svc.status === "ready" ? "" : `  (${svc.status})`;
      lines.push(`    ${svc.name.padEnd(18)} ${svc.url ?? svc.hostAddress}${state}`);
    }
  }

  if (manifest.status === "unhealthy") {
    const broken = manifest.services.filter((s) => s.status === "unhealthy").map((s) => s.name);
    lines.push(`  unhealthy: ${broken.join(", ")}. Run \`grove logs ${broken[0]}\` before anything else.`);
  } else if (manifest.status !== "ready") {
    lines.push("  Run `grove up` (or `grove up --group <name>`) before running anything against it.");
  }

  // What else is live on this machine, named. "3 other worktrees" tells a
  // session nothing it can act on — and a port that turns out to be taken is
  // almost always taken by one of these.
  const live = others.filter((w) => w.manifest?.status === "ready");
  if (live.length > 0) {
    lines.push(
      `  Also running: ${live.map((w) => `${w.slug} (${shortPorts(w.manifest)})`).join(", ")}.`,
    );
    lines.push("  Those belong to other worktrees. Do not use their ports, or stop them.");
  }
  if (others.length > live.length) {
    lines.push(`  ${others.length - live.length} other worktrees idle. \`grove ls --all\` for everything.`);
  }

  console.log(lines.join("\n"));
}

/**
 * `SessionEnd` has no turn to render into, so it cannot ask a question — which
 * means the only thing safe to automate here is the reversible one. `down` keeps
 * volumes, data and port leases; `grove up` brings it all back in seconds. Removal
 * stays manual, forever.
 */
async function sessionEnd(opts: HookOptions): Promise<void> {
  const ctx = await loadContext();
  if (ctx.config.hooks.onSessionEnd !== "down") return;

  const result = await compose(ctx, ["stop"]);
  if (opts.json) printJson({ ok: result.code === 0, action: "stop", worktree: ctx.slug });
  else if (result.code === 0) console.log(`git-grove: stopped ${ctx.slug} (data kept).`);
}
