import net from "node:net";
import { compose, composeLogs, type ComposePs } from "./compose.js";
import { internalUrl, serviceUrl, type Context } from "./context.js";
import { sleep } from "./exec.js";
import { isAlive, readProcesses, tailLog } from "./processes.js";
import type { ServiceConfig, ServiceStatus } from "../types.js";

const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 3_000;
const LOG_TAIL = 50;

export interface RuntimeService {
  config: ServiceConfig;
  status: ServiceStatus;
  url: string | null;
  internalUrl: string | null;
  hostAddress: string | null;
  lastLogs?: string[];
}

/**
 * Merge declared services with what Compose actually reports.
 *
 * A service with no container is `not-started` — deliberately out of scope, not
 * broken. Everything running starts at `starting` and is promoted by probing.
 */
export function buildRuntime(ctx: Context, ps: ComposePs[]): RuntimeService[] {
  const byService = new Map(ps.map((p) => [p.service, p]));

  return ctx.config.services.map((config) => {
    const row = byService.get(config.name);
    const lease = ctx.leases[config.name];

    let status: ServiceStatus;
    if (config.runtime === "host") {
      // Compose has never heard of this one and never will. It starts as
      // `not-started` — nobody asked *us* to start it — and `probeHosts`
      // promotes it if something is in fact listening on its leased port.
      status = "not-started";
    } else if (!row) status = "not-started";
    else if (row.state === "running") status = "starting";
    else status = "stopped";

    return {
      config,
      status,
      url: serviceUrl(ctx, config),
      internalUrl: internalUrl(config),
      hostAddress: lease === undefined ? null : `localhost:${lease}`,
    };
  });
}

/**
 * One probe round, promoting `starting` -> `ready`.
 *
 * Never marks anything unhealthy: a single missed probe is not evidence of
 * failure, only of not-yet. Read-only callers (`status`, `run`) use this so they
 * report `ready` for a stack that is genuinely up, without waiting on anything.
 */
export async function probeOnce(ctx: Context, runtime: RuntimeService[]): Promise<void> {
  await Promise.all(
    runtime
      .filter((s) => s.status === "starting")
      .map(async (svc) => {
        if (await probe(ctx, svc)) svc.status = "ready";
      }),
  );
  await probeHosts(ctx, runtime);
}

/**
 * Report whether host processes are listening on the ports we leased them.
 *
 * Purely observational, and deliberately outside the readiness gate: `wt` did
 * not start these and cannot start them, so "nothing is listening yet" is not a
 * failure it may report — it would make `wt up` hang and `wt run` refuse over a
 * process the developer simply has not launched. A host service is `ready` when
 * its port answers and `not-started` otherwise, and `not-started` is already the
 * status that means "nobody asked for this", which is exactly right here.
 */
export async function probeHosts(ctx: Context, runtime: RuntimeService[]): Promise<void> {
  const running = await readProcesses(ctx.root);

  await Promise.all(
    runtime
      .filter((s) => s.config.runtime === "host")
      .map(async (svc) => {
        // Someone upstream already reached a verdict and attached the evidence
        // for it — a port collision detected before starting, or a process seen
        // to die while waiting. Re-deriving it from the port here would discard
        // both the status and the explanation.
        if (svc.status === "unhealthy") return;

        const lease = ctx.leases[svc.config.name];
        const listening = lease !== undefined && (await tcpReachable(lease));
        const record = running[svc.config.name];

        // For a service we started, the pid is the authority and the open port
        // is only corroboration. A TCP probe cannot tell "my process is up" from
        // "somebody else is on that port" — and leases are deterministic, so an
        // orphan from a previous run is precisely the process most likely to be
        // sitting on it. Port-first reports `ready` for a stack that crashed on
        // startup, which is the worst answer available.
        if (svc.config.start) {
          if (!record) svc.status = "not-started";
          else if (!isAlive(record.pid)) svc.status = "unhealthy";
          else svc.status = listening ? "ready" : "starting";
          return;
        }

        // Nothing we started, so the port is all the evidence there is.
        svc.status = listening ? "ready" : "not-started";
      }),
  );
}

export interface WaitResult {
  ok: boolean;
  /** Services that never became ready, with logs attached. */
  failed: RuntimeService[];
}

/**
 * Poll until every in-scope service is ready, or the deadline passes.
 *
 * Probing goes through the proxy URL rather than straight at the container: that
 * validates routing as well as liveness, and absorbs the second or two Traefik
 * takes to notice a new container on the Docker event stream.
 */
export async function waitReady(
  ctx: Context,
  runtime: RuntimeService[],
  timeoutMs = ctx.config.healthTimeoutMs,
  onTick?: (pending: string[]) => void,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(
    runtime.filter((s) => s.status === "starting").map((s) => [s.config.name, s]),
  );

  while (pending.size > 0 && Date.now() < deadline) {
    for (const [name, svc] of [...pending]) {
      if (await probe(ctx, svc)) {
        svc.status = "ready";
        pending.delete(name);
      }
    }
    if (pending.size === 0) break;

    // A container that has exited will never become healthy. Fail immediately
    // instead of burning the full timeout on something already dead.
    const dead = await exitedServices(ctx, [...pending.keys()]);
    for (const name of dead) {
      const svc = pending.get(name);
      if (!svc) continue;
      svc.status = "unhealthy";
      svc.lastLogs = await logsFor(ctx, svc, LOG_TAIL);
      pending.delete(name);
    }

    // The same rule for a host process we started: once it is gone it is never
    // going to answer, and its log is the only thing that explains why.
    const ledger = await readProcesses(ctx.root);
    for (const [name, svc] of [...pending]) {
      if (svc.config.runtime !== "host" || !svc.config.start) continue;
      const record = ledger[name];
      if (record && isAlive(record.pid)) continue;
      svc.status = "unhealthy";
      svc.lastLogs = await logsFor(ctx, svc, LOG_TAIL);
      pending.delete(name);
    }
    if (pending.size === 0) break;

    onTick?.([...pending.keys()]);
    await sleep(POLL_INTERVAL_MS);
  }

  // Whatever is still pending timed out. Attach logs so the failure explains itself.
  for (const svc of pending.values()) {
    svc.status = "unhealthy";
    svc.lastLogs = await logsFor(ctx, svc, LOG_TAIL);
  }

  const failed = runtime.filter((s) => s.status === "unhealthy");
  return { ok: failed.length === 0, failed };
}

/** Compose logs for a container, our own capture file for a process we started. */
async function logsFor(ctx: Context, svc: RuntimeService, lines: number): Promise<string[]> {
  return svc.config.runtime === "host"
    ? tailLog(ctx.root, svc.config.name, lines)
    : composeLogs(ctx, svc.config.name, lines);
}

async function exitedServices(ctx: Context, names: string[]): Promise<string[]> {
  const { code, stdout } = await compose(ctx, ["ps", "--all", "--format", "json"]);
  if (code !== 0 || !stdout.trim()) return [];

  const text = stdout.trim();
  let rows: unknown[];
  try {
    rows = text.startsWith("[")
      ? (JSON.parse(text) as unknown[])
      : text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
  } catch {
    return [];
  }

  const wanted = new Set(names);
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => wanted.has(String(r.Service ?? "")))
    .filter((r) => {
      const state = String(r.State ?? "");
      return state === "exited" || state === "dead";
    })
    .map((r) => String(r.Service));
}

async function probe(ctx: Context, svc: RuntimeService): Promise<boolean> {
  switch (svc.config.health.kind) {
    case "none":
      // Compose already told us the container is running; nothing more to check.
      return true;

    case "http": {
      if (!svc.url) return false;
      try {
        const res = await fetch(svc.url + svc.config.health.path, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          redirect: "manual",
        });
        // 4xx/5xx both mean not-ready here: a 404 on a configured health path is a
        // misconfiguration, and Traefik answers 404 until it has picked up the route.
        return res.status < 400;
      } catch {
        return false;
      }
    }

    case "exec": {
      const { code } = await compose(ctx, [
        "exec",
        "-T",
        svc.config.name,
        ...svc.config.health.command,
      ]);
      return code === 0;
    }

    case "tcp": {
      const lease = ctx.leases[svc.config.name];
      if (lease === undefined) return false;

      // For a process we started, an open port is not sufficient evidence.
      // Leases are deterministic, so the port a worktree gets is exactly the one
      // an orphan of its own previous run is holding — and answering `ready`
      // against a stranger's socket is worse than answering `starting`.
      if (svc.config.runtime === "host" && svc.config.start) {
        const record = (await readProcesses(ctx.root))[svc.config.name];
        if (!record || !isAlive(record.pid)) return false;
      }
      return tcpReachable(lease);
    }
  }
}

/**
 * Is anything listening on this port, on either loopback address?
 *
 * Both are required, and probing only IPv4 was a real false negative: a Vite dev
 * server binds `::1` alone, so `wt status` reported "not running" for a server
 * that was happily serving — and the workaround was to remove its health check,
 * which is the opposite of what a health check is for. Node resolves `localhost`
 * to `::1` first on Windows, so anything started through a URL rather than an
 * explicit bind address is likely to land there.
 */
export function tcpReachable(port: number): Promise<boolean> {
  return Promise.all([connectTo(port, "127.0.0.1"), connectTo(port, "::1")]).then((r) =>
    r.some(Boolean),
  );
}

function connectTo(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}
