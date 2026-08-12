import { execSafe } from "./exec.js";
import { PROXY_PROJECT } from "./proxy.js";

/** Every container this tool creates carries it, via the overlay and the proxy file. */
export const MANAGED_LABEL = "wt.managed=true";
const PROJECT_LABEL = "com.docker.compose.project";

export interface ManagedContainer {
  id: string;
  name: string;
  state: string;
  /** Compose project name, which for a worktree stack is its slug. */
  project: string;
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Containers labelled as ours, including stopped ones.
 *
 * The proxy is excluded: it is shared machine-wide and belongs to no worktree, so
 * every caller here would otherwise have to remember to special-case it - and
 * exactly one forgotten check means `grove gc` tears down the ingress for every
 * running stack on the machine.
 */
export async function managedContainers(): Promise<ManagedContainer[]> {
  const { code, stdout } = await execSafe("docker", [
    "ps",
    "--all",
    "--filter",
    `label=${MANAGED_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${PROJECT_LABEL}"}}`,
  ]);
  if (code !== 0) return [];

  return lines(stdout)
    .map((line) => {
      const [id = "", name = "", state = "", project = ""] = line.split("\t");
      return { id, name, state, project };
    })
    .filter((container) => container.project !== "" && container.project !== PROXY_PROJECT);
}

export interface RemovedResources {
  containers: number;
  volumes: number;
  networks: number;
}

/**
 * Tear a Compose project down by label rather than by file.
 *
 * `docker compose down` needs the compose files, which is precisely what is gone
 * when the worktree that held them has been deleted. Labels survive the files,
 * so this is the only teardown that works on an orphan.
 */
export async function removeProject(
  project: string,
  opts: { volumes: boolean; dryRun?: boolean },
): Promise<RemovedResources> {
  const filter = `label=${PROJECT_LABEL}=${project}`;

  const containers = lines((await execSafe("docker", ["ps", "-aq", "--filter", filter])).stdout);
  const volumes = opts.volumes
    ? lines((await execSafe("docker", ["volume", "ls", "-q", "--filter", filter])).stdout)
    : [];
  const networks = lines((await execSafe("docker", ["network", "ls", "-q", "--filter", filter])).stdout);

  if (!opts.dryRun) {
    if (containers.length > 0) await execSafe("docker", ["rm", "-f", ...containers]);
    // Volumes only detach once their containers are gone, so the order matters.
    if (volumes.length > 0) await execSafe("docker", ["volume", "rm", "-f", ...volumes]);
    if (networks.length > 0) await execSafe("docker", ["network", "rm", ...networks]);
  }

  return { containers: containers.length, volumes: volumes.length, networks: networks.length };
}

export async function dockerAvailable(): Promise<boolean> {
  const { code } = await execSafe("docker", ["version", "--format", "{{.Server.Version}}"]);
  return code === 0;
}
