import path from "node:path";
import { execOrThrow } from "../core/exec.js";
import { gitRoot } from "../core/context.js";
import { readManifest } from "../core/manifest.js";
import { c, printJson, table } from "../core/output.js";
import type { Manifest, StackStatus } from "../types.js";

export interface LsOptions {
  json: boolean;
}

interface Entry {
  path: string;
  branch: string;
  slug: string | null;
  status: StackStatus | "unknown";
  baseUrl: string | null;
  updatedAt: string | null;
}

/**
 * Enumerated from git rather than from a registry, so it is correct even for
 * worktrees created by hand with `git worktree add`.
 */
async function gitWorktrees(cwd: string): Promise<{ path: string; branch: string }[]> {
  const { stdout } = await execOrThrow("git", ["worktree", "list", "--porcelain"], { cwd });

  const out: { path: string; branch: string }[] = [];
  let current: { path?: string; branch?: string } = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("detached")) {
      current.branch = "(detached)";
    } else if (line.trim() === "" && current.path) {
      out.push({ path: current.path, branch: current.branch ?? "(unknown)" });
      current = {};
    }
  }
  if (current.path) out.push({ path: current.path, branch: current.branch ?? "(unknown)" });
  return out;
}

export async function ls(opts: LsOptions): Promise<void> {
  const root = await gitRoot();
  const worktrees = await gitWorktrees(root);

  const entries: Entry[] = await Promise.all(
    worktrees.map(async (wt) => {
      const manifest: Manifest | null = await readManifest(wt.path);
      return {
        path: wt.path,
        branch: wt.branch,
        slug: manifest?.worktree ?? null,
        status: manifest?.status ?? "unknown",
        baseUrl: manifest?.baseUrl ?? null,
        updatedAt: manifest?.updatedAt ?? null,
      };
    }),
  );

  if (opts.json) {
    printJson({ ok: true, worktrees: entries });
    return;
  }

  if (entries.length === 0) {
    console.log(c.dim("no worktrees"));
    return;
  }

  const style = (s: Entry["status"]) =>
    s === "ready"
      ? c.green(s)
      : s === "unhealthy"
        ? c.red(s)
        : s === "starting"
          ? c.yellow(s)
          : c.dim(s);

  const rows = entries.map((e) => [
    e.slug ?? c.dim("—"),
    e.branch,
    style(e.status),
    e.baseUrl ?? c.dim("—"),
    c.dim(path.basename(e.path)),
  ]);

  console.log(table(["WORKTREE", "BRANCH", "STATUS", "URL", "DIR"], rows));
}
