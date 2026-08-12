import path from "node:path";
import { loadConfig } from "../core/config.js";
import { gitRoot } from "../core/context.js";
import { dockerAvailable, managedContainers, removeProject } from "../core/docker.js";
import { mainWorktree, pruneWorktrees } from "../core/git.js";
import { exists } from "../core/glob.js";
import { readJson, withLock, writeJson } from "../core/lock.js";
import { c, printJson } from "../core/output.js";
import { leasesFile } from "../core/paths.js";
import { proxyStatus, stopProxy } from "../core/proxy.js";
import { readRegistry, register, unregister } from "../core/registry.js";
import { liveSlugs, surveyWorktrees } from "../core/worktrees.js";

export interface GcOptions {
  json: boolean;
  dryRun: boolean;
  /** Also stop the shared proxy when no managed container is left running. */
  proxy: boolean;
}

type ActionKind = "containers" | "leases" | "registry" | "register" | "proxy" | "unknown";

interface GcAction {
  kind: ActionKind;
  target: string;
  detail: string;
}

/**
 * Reclaim what nothing owns any more.
 *
 * Orphans are how tools like this rot: a worktree deleted with `rm -rf` instead
 * of `grove rm` leaves containers holding memory, volumes holding disk and port
 * leases holding numbers, none of which anything will ever ask about again.
 *
 * The safety rule is what makes this usable, and it is stricter than it looks:
 * **gc deletes only what it can prove is dead, never what it merely fails to
 * recognise.** A slug is dead when we hold a record of it — a registry entry or
 * a port lease — whose worktree is gone. A slug we have never heard of is left
 * strictly alone and only reported, because the alternative is that a deleted
 * registry file turns `grove gc` into "destroy every stack on this machine".
 */
export async function gc(opts: GcOptions): Promise<void> {
  const actions: GcAction[] = [];
  const act = (kind: ActionKind, target: string, detail: string) => {
    actions.push({ kind, target, detail });
  };

  // Git first: a pruned worktree list is what makes the registry comparison below
  // meaningful, and `git worktree prune` only drops administrative files.
  let repo: string | null = null;
  try {
    repo = await mainWorktree(await gitRoot());
    if (!opts.dryRun) await pruneWorktrees(repo);
  } catch {
    // Outside a repo, gc still cleans machine-global state.
  }

  const live = await liveSlugs();

  // Worktrees git knows about that the registry does not. Self-healing rather
  // than destructive: an unregistered worktree is invisible to a gc run started
  // from any other repository, which is how live stacks get swept by mistake.
  if (repo) {
    const registry = await readRegistry();
    const known = new Set(registry.worktrees.map((w) => path.resolve(w.root)));
    for (const grove of await surveyWorktrees()) {
      if (!grove.slug || known.has(path.resolve(grove.path))) continue;
      act("register", grove.slug, grove.path);
      if (!opts.dryRun) {
        await register({ slug: grove.slug, root: grove.path, branch: grove.branch, repo });
      }
    }
  }

  // Slugs we have a record of whose worktree is gone. This — and only this — is
  // what authorises deleting containers and volumes.
  const dead = new Set<string>();

  for (const entry of (await readRegistry()).worktrees) {
    if (await exists(entry.root)) continue;
    dead.add(entry.slug);
    act("registry", entry.slug, entry.root);
    if (!opts.dryRun) await unregister(entry.root);
  }

  // Leases held for slugs that no longer exist. Cheap to reclaim, and the range
  // is finite, so this is what keeps `leasePort` from eventually failing. A lease
  // is also a record, so its slug counts as known-dead.
  const orphanLeases = await sweepLeases(live, opts.dryRun);
  for (const [key, port] of orphanLeases) {
    const slug = key.split("/")[0];
    if (slug) dead.add(slug);
    act("leases", key, String(port));
  }

  const haveDocker = await dockerAvailable();
  if (haveDocker) {
    const counts = new Map<string, number>();
    for (const container of await managedContainers()) {
      if (live.has(container.project)) continue;
      counts.set(container.project, (counts.get(container.project) ?? 0) + 1);
    }

    for (const [project, count] of [...counts].sort()) {
      if (!dead.has(project)) {
        // Belongs to a repo this machine has not registered — most likely a
        // worktree of a project we simply have not been run in yet.
        act("unknown", project, `${count} containers left alone (no record of this worktree)`);
        continue;
      }
      const removed = await removeProject(project, { volumes: true, dryRun: opts.dryRun });
      act(
        "containers",
        project,
        `${count} containers, ${removed.volumes} volumes, ${removed.networks} networks`,
      );
    }
  }

  // The loose end: `grove down` on the last worktree leaves the shared proxy up.
  // Nothing else reaps it. Opt-in, because the proxy is machine-wide and one
  // repo's cleanup should not silently cut ingress for another's.
  if (haveDocker && opts.proxy) {
    const stillRunning = (await managedContainers()).some((cont) => cont.state === "running");
    if (!stillRunning) {
      const config = await loadConfigQuietly();
      const proxy = config ? await proxyStatus(config) : null;
      if (proxy?.running) {
        act("proxy", "easy-worktree-proxy", "stopped, nothing left to route to");
        if (!opts.dryRun) await stopProxy();
      }
    }
  }

  if (opts.json) {
    printJson({ ok: true, dryRun: opts.dryRun, actions });
    return;
  }

  if (actions.length === 0) {
    console.log(c.dim("nothing to collect"));
    return;
  }

  const verb = opts.dryRun ? c.yellow("would") : c.green("did");
  for (const action of actions) {
    const mark = action.kind === "unknown" ? c.dim("skip ") : verb;
    console.log(`${mark} ${action.kind.padEnd(10)} ${action.target}  ${c.dim(action.detail)}`);
  }
  if (opts.dryRun) console.log(c.dim("\ndry run — re-run without --dry-run to apply"));
}

async function sweepLeases(live: Set<string>, dryRun: boolean): Promise<[string, number][]> {
  const file = leasesFile();
  return withLock(file, async () => {
    const leases = await readJson<Record<string, number>>(file, {});
    const orphans: [string, number][] = [];

    for (const [key, port] of Object.entries(leases)) {
      const slug = key.split("/")[0];
      if (!slug || live.has(slug)) continue;
      orphans.push([key, port]);
      if (!dryRun) delete leases[key];
    }

    if (!dryRun && orphans.length > 0) await writeJson(file, leases);
    return orphans.sort((a, b) => a[0].localeCompare(b[0]));
  });
}

/** The proxy config is per-repo; outside one we simply do not reap the proxy. */
async function loadConfigQuietly() {
  try {
    return await loadConfig(await gitRoot());
  } catch {
    return null;
  }
}
