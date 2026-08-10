import net from "node:net";
import { compose, composeLogs, type ComposePs } from "./compose.js";
import { internalUrl, serviceUrl, type Context } from "./context.js";
import { sleep } from "./exec.js";
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
    if (!row) status = "not-started";
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
      svc.lastLogs = await composeLogs(ctx, name, LOG_TAIL);
      pending.delete(name);
    }
    if (pending.size === 0) break;

    onTick?.([...pending.keys()]);
    await sleep(POLL_INTERVAL_MS);
  }

  // Whatever is still pending timed out. Attach logs so the failure explains itself.
  for (const svc of pending.values()) {
    svc.status = "unhealthy";
    svc.lastLogs = await composeLogs(ctx, svc.config.name, LOG_TAIL);
  }

  const failed = runtime.filter((s) => s.status === "unhealthy");
  return { ok: failed.length === 0, failed };
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
      return tcpReachable(lease);
    }
  }
}

function tcpReachable(port: number): Promise<boolean> {
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
    socket.connect(port, "127.0.0.1");
  });
}
