/** Everything in this file that appears in `.wt/manifest.json` is a public contract. */

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * `not-started` is load-bearing: it means "nobody asked for this service", and is
 * distinct from `unhealthy` ("we asked and it failed"). Without the distinction an
 * agent will try to repair a service that was deliberately left out of scope.
 */
export type ServiceStatus =
  | "ready"
  | "starting"
  | "unhealthy"
  | "stopped"
  | "not-started";

export type StackStatus = "ready" | "starting" | "unhealthy" | "stopped";

export type Layer = "frontend" | "backend" | "worker" | "data" | "infra";

/** How to tell whether a service is actually up. */
export type HealthCheck =
  /** HTTP GET this path through the proxy. Requires an ingress subdomain. */
  | { kind: "http"; path: string }
  /** Run a command inside the container; exit 0 means healthy. */
  | { kind: "exec"; command: string[] }
  /** Open a TCP connection to the leased host port. */
  | { kind: "tcp" }
  /** No check — ready as soon as Compose reports the container running. */
  | { kind: "none" };

/**
 * Who runs the process.
 *
 * `compose` is a container this tool starts and stops. `host` is a process it
 * does not run at all — an orchestrator, a `the run command`, a dev server you
 * start in your own terminal. For those, the only thing `wt` can usefully own is
 * the port, which it leases and then hands back through `[render]` and the
 * injected environment.
 *
 * This is what makes the tool useful to a stack that is not containerised: the
 * proxy trick needs a Docker network to hide identical ports inside, and a host
 * process has none. Leasing a distinct port per worktree is the fallback, and it
 * is the whole of what such a stack actually needs.
 */
export type ServiceRuntime = "compose" | "host";

export interface ServiceConfig {
  name: string;
  layer: Layer;
  /** Defaults to `compose`. */
  runtime: ServiceRuntime;
  /** Present => the service gets a Traefik route at `<subdomain>.<slug>.<domain>`. */
  subdomain?: string;
  /** Port the process listens on inside the container. */
  port?: number;
  /** Publish a leased host port (for things the proxy can't front, e.g. Postgres). */
  hostPort?: boolean;
  /**
   * `host` services only: how to launch it.
   *
   * Present, and `wt up` starts the process with the worktree's environment
   * injected, tracks its pid and waits for it to answer — the same contract a
   * container gets. Absent, and the service is a port reservation this tool
   * merely observes, for something you start yourself.
   */
  start?: string;
  health: HealthCheck;
}

/**
 * What a fresh worktree needs before it can run, and none of which git brings
 * along — every one of these paths is gitignored by definition.
 *
 * `copy` for things you may edit per worktree (`.env`); `link` for things that
 * are large and identical (`node_modules`); `run` for the install command that
 * rebuilds them when the branch actually changed its dependencies.
 */
export interface HydrateConfig {
  copy: string[];
  link: string[];
  run: string[];
  /**
   * Files whose hashes decide `link` vs `run`. Empty means "auto-detect the usual
   * suspects at the root".
   */
  lockfiles: string[];
}

export interface HooksConfig {
  /** `status` injects stack state into the agent's first turn. */
  onSessionStart: "status" | "off";
  /**
   * `SessionEnd` cannot ask a question — the session is over and there is no turn
   * to render a prompt into. So the only automatable action is the reversible
   * one: `down` stops containers and keeps every byte of data. Never `rm`.
   */
  onSessionEnd: "off" | "down";
}

export interface Config {
  project: { name: string; compose: string[] };
  domain: string;
  proxy: { port: number; network: string; image: string };
  services: ServiceConfig[];
  groups: Record<string, string[]>;
  commands: Record<string, string>;
  /** Templates interpolated against the injected vars, e.g. DATABASE_URL. */
  env: Record<string, string>;
  healthTimeoutMs: number;
  hydrate: HydrateConfig;
  hooks: HooksConfig;
  /**
   * Files written from this worktree's environment, keyed by path relative to the
   * worktree root.
   *
   * The counterpart to `host` services: leasing a port is only useful if the
   * process that needs it can find out what it got. Most non-containerised
   * stacks already read a local config file — an orchestrator reads
   * `the generated config`, a Vite app reads `.env.local` — so rendering that
   * one file per worktree is the whole integration.
   */
  render: Record<string, string>;
}

/** `.wt/state.json` — identity of this worktree, written once and then stable. */
export interface WorktreeState {
  slug: string;
  branch: string;
  /**
   * Absolute path this state was created for. Guards against a state file that
   * arrived by commit or by directory copy: without it, an inherited slug would
   * point one worktree's commands at another worktree's containers.
   */
  root: string;
  createdAt: string;
}

export interface ManifestService {
  name: string;
  layer: Layer;
  /** `host` services are not started or stopped by this tool — see ServiceRuntime. */
  runtime: ServiceRuntime;
  status: ServiceStatus;
  /** External URL through the proxy, or null for services with no ingress. */
  url: string | null;
  /** Address usable from *inside* the compose network. */
  internalUrl: string | null;
  /** Host-side address for leased ports, e.g. `localhost:24310`. */
  hostAddress: string | null;
  health: string | null;
  logs: string;
  /** Populated only when status is `unhealthy`, so failures are self-explaining. */
  lastLogs?: string[];
}

export interface Manifest {
  schemaVersion: number;
  worktree: string;
  branch: string;
  root: string;
  /** `ready` iff every service in `scope` is ready. */
  status: StackStatus;
  /** Services Compose actually has containers for. Derived from `compose ps`. */
  scope: string[];
  baseUrl: string | null;
  apiUrl: string | null;
  services: ManifestService[];
  commands: Record<string, string>;
  /**
   * Files written from `[render]`, relative to the worktree root. Additive to
   * schema 1: a consumer that does not know about it is unaffected.
   */
  rendered: string[];
  updatedAt: string;
}

/** Shape of every `--json` error payload. Agents branch on this. */
export interface ErrorPayload {
  ok: false;
  error: string;
  hint?: string;
  service?: string;
  logs?: string[];
}
