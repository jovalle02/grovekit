import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE = path.join(REPO_ROOT, "examples", "sample-app");

const CLI = path.join(REPO_ROOT, "src", "cli.ts");

/**
 * Absolute, because the CLI is spawned with its cwd inside a temp worktree —
 * a bare `--import tsx` would be resolved from *there* and not found.
 */
const TSX = import.meta.resolve("tsx");

let counter = 0;
const created: string[] = [];

/**
 * A throwaway directory, removed when the suite exits.
 *
 * Under the OS temp dir rather than the repo so a crashed run never leaves a
 * half-built git worktree inside the project — which git then refuses to prune.
 */
export async function tmpDir(label = "grove"): Promise<string> {
  const dir = path.join(
    await fs.realpath(os.tmpdir()),
    "git-grove-tests",
    `${label}-${process.pid}-${counter++}`,
  );
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}

export async function cleanup(): Promise<void> {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

export async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

export async function read(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout, for `--json` runs. Null when it was not JSON. */
  json<T>(): T;
}

export interface RunOptions {
  cwd: string;
  /** Machine-global state dir. Always isolated so tests never touch the real one. */
  home?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Run the CLI the way a user does — a real process, real argv, real exit code.
 *
 * Every bug this project has actually shipped lived in the seam between modules
 * (argument re-quoting, exit-code passthrough, a manifest written on a path that
 * only runs on failure), so the tests that matter go through `main()`.
 */
export function runCli(args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        EASY_WORKTREE_HOME: opts.home ?? path.join(opts.cwd, ".wt-home"),
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        json<T>(): T {
          try {
            return JSON.parse(stdout) as T;
          } catch {
            throw new Error(`stdout was not JSON:\n${stdout}\n${stderr}`);
          }
        },
      });
    });
  });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`)),
    );
  });
}

/**
 * A git repo containing the sample app.
 *
 * `branch` is worth overriding for anything that boots Docker: the slug becomes
 * the Compose project name, so two test repos on `main` would drive the same
 * containers — and so would a real worktree of the user's called `main`.
 */
export async function makeRepo(label = "repo", branch = "main"): Promise<string> {
  const dir = await tmpDir(label);
  const root = path.join(dir, "app");
  await fs.cp(FIXTURE, root, { recursive: true });

  await git(root, ["init", "-q", "-b", branch]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "test"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "init"]);
  return root;
}

/**
 * Replace the fixture's `[hydrate]` table.
 *
 * Appending a second one would be a duplicate-table TOML error, and the failure
 * would look like a config-parsing bug rather than a test-setup mistake.
 */
export async function setHydrate(root: string, body: string): Promise<void> {
  const file = path.join(root, "worktree.toml");
  const current = await fs.readFile(file, "utf8");
  const without = current.replace(/\n\[hydrate\][\s\S]*?(?=\n\[|$)/, "");
  await fs.writeFile(file, `${without.trimEnd()}\n\n[hydrate]\n${body.trim()}\n`, "utf8");
}

/**
 * Complete teardown for a Docker-backed test.
 *
 * `grove down --remove` deliberately keeps volumes — that is the whole point of the
 * down/rm split — so a test that only calls it leaks a Postgres volume per run.
 * Tests own the resources they create, so they clean up by label, which is the
 * same mechanism `grove rm` and `grove gc` use.
 */
export async function teardown(cwd: string, slug: string, home: string): Promise<void> {
  await runCli(["down", "--remove", "--json"], { cwd, home, timeoutMs: 120_000 }).catch(() => {});
  const { removeProject } = await import("../src/core/docker.js");
  await removeProject(slug, { volumes: true }).catch(() => {});
}

export const dockerTests = process.env.WT_TEST_DOCKER === "1";
