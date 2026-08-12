import { compose, composePs } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { buildRuntime, probeOnce } from "../core/health.js";
import { buildManifest, writeManifest } from "../core/manifest.js";
import { printJson } from "../core/output.js";
import { surveyWorktrees } from "../core/worktrees.js";

export interface HookOptions {
  json: boolean;
  event: string;
}

export const HOOK_EVENTS = ["session-start", "session-end"] as const;

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

  const runtime = buildRuntime(ctx, await composePs(ctx));
  await probeOnce(ctx, runtime);
  const manifest = await writeManifest(ctx, buildManifest(ctx, runtime));

  const worktrees = await surveyWorktrees().catch(() => []);
  const others = worktrees.filter((w) => w.slug && w.slug !== ctx.slug);
  const running = others.filter((w) => w.manifest?.status === "ready").length;

  if (opts.json) {
    printJson({ ok: true, manifest, otherWorktrees: others.length, otherRunning: running });
    return;
  }

  const lines = [`git-grove: worktree \`${ctx.slug}\` (branch ${ctx.branch}), stack ${manifest.status}.`];

  if (manifest.status === "ready") {
    lines.push(`  ${manifest.baseUrl ?? "no ingress"} — details in .wt/manifest.json.`);
  } else if (manifest.status === "unhealthy") {
    const broken = manifest.services.filter((s) => s.status === "unhealthy").map((s) => s.name);
    lines.push(`  unhealthy: ${broken.join(", ")}. Run \`grove logs ${broken[0]}\` before anything else.`);
  } else {
    lines.push("  Run `grove up` (or `grove up --group <name>`) before running anything against it.");
  }

  if (others.length > 0) {
    lines.push(`  ${others.length} other worktrees, ${running} running. \`grove ls\` / \`grove gc --dry-run\`.`);
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
