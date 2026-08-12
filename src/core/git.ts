import path from "node:path";
import { exec, execOrThrow } from "./exec.js";

export interface GitWorktree {
  /** Absolute, resolved. Git prints forward slashes even on Windows. */
  path: string;
  branch: string;
  head: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Enumerating from git rather than from our registry is deliberate: worktrees
 * created by hand with `git worktree add` must show up too, or `grove ls` lies and
 * `grove gc` deletes things it should not.
 */
export function parseWorktreeList(stdout: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;

  const flush = () => {
    if (current?.path) {
      out.push({
        path: path.resolve(current.path),
        branch: current.branch ?? (current.detached ? "(detached)" : "(unknown)"),
        head: current.head ?? "",
        detached: current.detached ?? false,
        bare: current.bare ?? false,
        locked: current.locked ?? false,
      });
    }
    current = null;
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return out;
}

export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const { stdout } = await execOrThrow("git", ["worktree", "list", "--porcelain"], { cwd });
  return parseWorktreeList(stdout);
}

/**
 * The main worktree - always the first entry git prints, and the only one that
 * cannot be removed. Used as the identity of the repository as a whole.
 */
export async function mainWorktree(cwd: string): Promise<string> {
  const list = await listWorktrees(cwd);
  const first = list[0];
  if (!first) throw new Error("git reported no worktrees");
  return first.path;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const { code } = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
  });
  return code === 0;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  const { code } = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
  return code === 0;
}

/**
 * Where a new branch starts when `--from` is not given: HEAD, the same as
 * `git switch -c` and `git worktree add -b`.
 *
 * This used to prefer `main`, on the theory that new work starts from the
 * trunk. Using it on a real repo showed why that is wrong: the config enabling
 * this tool was on a feature branch, `grove new` branched from `main` instead, and
 * the new worktree had no worktree.toml at all. Silently ignoring the branch
 * someone is standing on is surprising in a way "branch from here" never is,
 * and `--from main` says the other thing in five characters.
 */
export async function defaultBaseRef(cwd: string): Promise<string> {
  const { stdout } = await execOrThrow("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = stdout.trim();
  // Detached HEAD has no branch name to hand `git worktree add`; the sha does.
  if (branch !== "HEAD") return branch;
  const { stdout: sha } = await execOrThrow("git", ["rev-parse", "HEAD"], { cwd });
  return sha.trim();
}

export async function addWorktree(
  cwd: string,
  dest: string,
  branch: string,
  from: string | null,
): Promise<void> {
  const args = from
    ? ["worktree", "add", "-b", branch, dest, from]
    : ["worktree", "add", dest, branch];
  await execOrThrow("git", args, { cwd });
}

export async function removeWorktree(cwd: string, target: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), target];
  await execOrThrow("git", args, { cwd });
}

export async function pruneWorktrees(cwd: string): Promise<void> {
  await exec("git", ["worktree", "prune"], { cwd });
}

export async function deleteBranch(cwd: string, branch: string, force: boolean): Promise<boolean> {
  const { code } = await exec("git", ["branch", force ? "-D" : "-d", branch], { cwd });
  return code === 0;
}

/** Uncommitted changes, including untracked files - `grove rm` must not eat work. */
export async function isDirty(root: string): Promise<boolean> {
  const { code, stdout } = await exec("git", ["status", "--porcelain"], { cwd: root });
  return code === 0 && stdout.trim().length > 0;
}
