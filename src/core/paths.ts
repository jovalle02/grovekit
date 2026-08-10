import os from "node:os";
import path from "node:path";

/** Machine-global state: the shared proxy, the worktree registry, port leases. */
export function stateDir(): string {
  return process.env.EASY_WORKTREE_HOME ?? path.join(os.homedir(), ".easy-worktree");
}

export const proxyDir = () => path.join(stateDir(), "proxy");
export const proxyComposeFile = () => path.join(proxyDir(), "docker-compose.yml");
export const leasesFile = () => path.join(stateDir(), "leases.json");
export const registryFile = () => path.join(stateDir(), "registry.json");

/** Per-worktree runtime state. Gitignored; lives inside the worktree by design, so
 *  that a relative read resolves correctly no matter which worktree you are in. */
export const wtDir = (root: string) => path.join(root, ".wt");
export const manifestFile = (root: string) => path.join(wtDir(root), "manifest.json");
export const stateFile = (root: string) => path.join(wtDir(root), "state.json");
