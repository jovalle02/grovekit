import path from "node:path";
import { gitRoot } from "../core/context.js";
import { listWorktrees } from "../core/git.js";
import { readManifest } from "../core/manifest.js";
import { c, printJson, table } from "../core/output.js";
import { readRegistry } from "../core/registry.js";
import { readState } from "../core/worktrees.js";
import type { Manifest, StackStatus } from "../types.js";

export interface LsOptions {
  json: boolean;
  /** Every worktree on this machine, not just this repository's. */
  all: boolean;
}

export interface LsEntry {
  path: string;
  /** Main worktree of the repo this belongs to - only meaningful with `--all`. */
  repo: string | null;
  branch: string;
  slug: string | null;
  status: StackStatus | "unknown";
  baseUrl: string | null;
  /** Every leased host address, keyed by service, so ports are visible at a glance. */
  ports: Record<string, string>;
  updatedAt: string | null;
}

function entryFor(
  worktreePath: string,
  branch: string,
  slug: string | null,
  repo: string | null,
  manifest: Manifest | null,
): LsEntry {
  const ports: Record<string, string> = {};
  for (const svc of manifest?.services ?? []) {
    if (svc.hostAddress) ports[svc.name] = svc.hostAddress;
  }
  return {
    path: worktreePath,
    repo,
    branch,
    slug: slug ?? manifest?.worktree ?? null,
    status: manifest?.status ?? "unknown",
    baseUrl: manifest?.baseUrl ?? null,
    ports,
    updatedAt: manifest?.updatedAt ?? null,
  };
}

/**
 * This repository's worktrees, enumerated from git.
 *
 * From git rather than the registry, so a worktree someone created by hand with
 * `git worktree add` still appears - the registry is a cache, and a listing that
 * silently omitted a real worktree would be worse than no listing.
 */
async function localEntries(): Promise<LsEntry[]> {
  const root = await gitRoot();
  const worktrees = await listWorktrees(root);

  return Promise.all(
    worktrees.map(async (wt) => {
      const [state, manifest] = await Promise.all([readState(wt.path), readManifest(wt.path)]);
      return entryFor(wt.path, wt.branch, state?.slug ?? null, null, manifest);
    }),
  );
}

/**
 * Every worktree this machine knows about, across every repository.
 *
 * The registry is the only thing that spans repos, which makes this the one
 * command that can answer "what else is running?" - the question you have when a
 * port is taken, or when a stack you did not start is holding memory, or when
 * you are about to stop something and want to know whose it is.
 */
async function allEntries(): Promise<LsEntry[]> {
  const registry = await readRegistry();

  const entries = await Promise.all(
    registry.worktrees.map(async (record) => {
      const [state, manifest] = await Promise.all([
        readState(record.root),
        readManifest(record.root),
      ]);
      // A registry row whose directory is gone is exactly what `grove gc`
      // reclaims; show it as such rather than hiding it.
      const gone = state === null && manifest === null;
      return {
        entry: entryFor(record.root, record.branch, record.slug, record.repo, manifest),
        gone,
      };
    }),
  );

  return entries.map(({ entry, gone }) => (gone ? { ...entry, status: "unknown" as const } : entry));
}

export async function ls(opts: LsOptions): Promise<void> {
  const entries = opts.all ? await allEntries() : await localEntries();

  if (opts.json) {
    printJson({ ok: true, scope: opts.all ? "machine" : "repo", worktrees: entries });
    return;
  }

  if (entries.length === 0) {
    console.log(c.dim(opts.all ? "no worktrees registered on this machine" : "no worktrees"));
    return;
  }

  const style = (s: LsEntry["status"]) =>
    s === "ready"
      ? c.green(s)
      : s === "unhealthy"
        ? c.red(s)
        : s === "starting"
          ? c.yellow(s)
          : c.dim(s);

  // Ports are the reason to run this: with two stacks up, "which one is on
  // 23236" is the question, and a URL column alone cannot answer it.
  const summarise = (ports: Record<string, string>): string => {
    const values = Object.values(ports);
    if (values.length === 0) return c.dim(" - ");
    const shown = values.slice(0, 3).map((v) => v.replace(/^localhost:/, ""));
    return shown.join(" ") + (values.length > 3 ? c.dim(` +${values.length - 3}`) : "");
  };

  const rows = entries.map((e) => {
    const cells = [
      e.slug ?? c.dim(" - "),
      e.branch,
      style(e.status),
      e.baseUrl ?? summarise(e.ports),
      c.dim(path.basename(e.path)),
    ];
    // With `--all` the directory basename is ambiguous across repos, so name the
    // repository too.
    if (opts.all) cells.splice(1, 0, c.dim(e.repo ? path.basename(e.repo) : " - "));
    return cells;
  });

  const headers = opts.all
    ? ["WORKTREE", "REPO", "BRANCH", "STATUS", "URL / PORTS", "DIR"]
    : ["WORKTREE", "BRANCH", "STATUS", "URL / PORTS", "DIR"];

  console.log(table(headers, rows));

  if (!opts.all) {
    console.log();
    console.log(c.dim("  grove ls --all - every worktree on this machine, across repos"));
  }
}
