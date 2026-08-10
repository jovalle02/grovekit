import path from "node:path";
import { exec, execOrThrow } from "./exec.js";
import { loadConfig } from "./config.js";
import { readJson, writeJson } from "./lock.js";
import { uniqueSlug } from "./naming.js";
import { stateFile } from "./paths.js";
import type { Config, ServiceConfig, WorktreeState } from "../types.js";

export class ContextError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface Context {
  /** Absolute path to this worktree's root. */
  root: string;
  slug: string;
  branch: string;
  config: Config;
  /** Host ports leased for `host_port` services, keyed by service name. */
  leases: Record<string, number>;
}

export async function gitRoot(cwd = process.cwd()): Promise<string> {
  const { code, stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (code !== 0) {
    throw new ContextError("Not inside a git repository.", "cd into your repo, or run `git init`.");
  }
  return path.resolve(stdout.trim());
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execOrThrow("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = stdout.trim();
  // Detached HEAD: fall back to the short sha so the slug is still stable.
  if (branch === "HEAD") {
    const { stdout: sha } = await execOrThrow("git", ["rev-parse", "--short", "HEAD"], { cwd });
    return `detached-${sha.trim()}`;
  }
  return branch;
}

/**
 * Resolve identity for the worktree we are standing in. The slug is persisted on
 * first use so that renaming the branch later does not silently orphan a running
 * stack (whose Compose project name is derived from the slug).
 */
export async function loadContext(cwd = process.cwd()): Promise<Context> {
  const root = await gitRoot(cwd);
  const branch = await currentBranch(root);
  const config = await loadConfig(root);

  const file = stateFile(root);
  let state = await readJson<WorktreeState | null>(file, null);

  // A state file naming a different directory did not originate here — it was
  // committed to the repo or came along in a copy. Trusting its slug would make
  // this worktree drive another one's containers, so discard and re-derive.
  if (state && (!state.root || path.resolve(state.root) !== root)) state = null;

  if (!state) {
    state = {
      slug: await freshSlug(root, branch),
      branch,
      root,
      createdAt: new Date().toISOString(),
    };
    await writeJson(file, state);
  }

  return { root, slug: state.slug, branch, config, leases: {} };
}

/**
 * Slugs are derived from the branch, and git forbids two worktrees on one branch,
 * so collisions only happen when two branch names slugify identically
 * (`feat/a-b` vs `feat/a_b`). Checked once, when state is first written.
 */
async function freshSlug(root: string, branch: string): Promise<string> {
  const taken = new Set<string>();
  try {
    const { stdout } = await execOrThrow("git", ["worktree", "list", "--porcelain"], { cwd: root });
    const paths = stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => path.resolve(l.slice("worktree ".length).trim()))
      .filter((p) => p !== root);

    for (const p of paths) {
      const other = await readJson<WorktreeState | null>(stateFile(p), null);
      if (other?.slug) taken.add(other.slug);
    }
  } catch {
    // Worst case we fall back to the plain slug; `wt up` would then surface the
    // clash as a Compose project collision rather than silently sharing one.
  }
  return uniqueSlug(branch, taken);
}

/** External URL for a service, or null when it has no ingress. */
export function serviceUrl(ctx: Context, svc: ServiceConfig): string | null {
  if (!svc.subdomain) return null;
  const port = ctx.config.proxy.port;
  const suffix = port === 80 ? "" : `:${port}`;
  return `http://${svc.subdomain}.${ctx.slug}.${ctx.config.domain}${suffix}`;
}

/** Address reachable from inside the compose network. */
export function internalUrl(svc: ServiceConfig): string | null {
  if (svc.port === undefined) return null;
  return `http://${svc.name}.internal:${svc.port}`;
}

export function findService(ctx: Context, name: string): ServiceConfig | undefined {
  return ctx.config.services.find((s) => s.name === name);
}

/**
 * Expand CLI service selectors into concrete service names. Accepts service
 * names and group names interchangeably; empty input means "everything".
 */
export function resolveSelection(ctx: Context, selectors: string[]): string[] {
  if (selectors.length === 0) return ctx.config.services.map((s) => s.name);

  const out = new Set<string>();
  for (const sel of selectors) {
    const group = ctx.config.groups[sel];
    if (group) {
      group.forEach((s) => out.add(s));
      continue;
    }
    if (ctx.config.services.some((s) => s.name === sel)) {
      out.add(sel);
      continue;
    }
    const known = [
      ...ctx.config.services.map((s) => s.name),
      ...Object.keys(ctx.config.groups),
    ].join(", ");
    throw new ContextError(`Unknown service or group "${sel}".`, `Known: ${known}`);
  }
  return [...out];
}
