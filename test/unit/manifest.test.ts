import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, stackStatus } from "../../src/core/manifest.js";
import { markFailedToStart } from "../../src/commands/up.js";
import type { Context } from "../../src/core/context.js";
import type { RuntimeService } from "../../src/core/health.js";
import type { Config, ServiceStatus } from "../../src/types.js";

function service(name: string, status: ServiceStatus, extra: Partial<RuntimeService> = {}): RuntimeService {
  return {
    config: {
      name,
      layer: extra.config?.layer ?? "backend",
      runtime: "compose",
      health: { kind: "none" },
      ...(extra.config ?? {}),
    },
    status,
    url: extra.url ?? null,
    internalUrl: extra.internalUrl ?? null,
    hostAddress: extra.hostAddress ?? null,
    ...(extra.lastLogs ? { lastLogs: extra.lastLogs } : {}),
  };
}

const config: Config = {
  project: { name: "demo", compose: ["docker-compose.yml"] },
  domain: "localtest.me",
  proxy: { port: 8081, network: "wt-proxy", image: "traefik:v3.6" },
  services: [],
  groups: {},
  commands: { e2e: "node e2e.mjs" },
  env: {},
  healthTimeoutMs: 120_000,
  hydrate: { copy: [], link: [], run: [], lockfiles: [] },
  hooks: { onSessionStart: "status", onSessionEnd: "off" },
  render: {},
};

const ctx: Context = {
  root: "/repo",
  slug: "fix-billing",
  branch: "fix/billing",
  config,
  leases: {},
};

describe("stackStatus", () => {
  // The single most load-bearing rule in the manifest: `ready` is computed over
  // the SCOPE, not over every declared service. Get this wrong and a partial
  // startup reports a broken stack, which makes `wt up --group` unusable.
  it("ignores not-started services entirely", () => {
    assert.equal(
      stackStatus([service("api", "ready"), service("db", "ready"), service("web", "not-started")]),
      "ready",
    );
  });

  it("is unhealthy if anything in scope is unhealthy, even when others are ready", () => {
    assert.equal(stackStatus([service("api", "unhealthy"), service("db", "ready")]), "unhealthy");
  });

  it("prefers unhealthy over starting", () => {
    assert.equal(stackStatus([service("api", "unhealthy"), service("db", "starting")]), "unhealthy");
  });

  it("is starting while anything in scope is still coming up", () => {
    assert.equal(stackStatus([service("api", "ready"), service("db", "starting")]), "starting");
  });

  it("is stopped when nothing was ever started", () => {
    assert.equal(stackStatus([service("api", "not-started"), service("web", "not-started")]), "stopped");
  });

  it("is stopped when every in-scope container is stopped", () => {
    assert.equal(stackStatus([service("api", "stopped"), service("db", "stopped")]), "stopped");
  });

  it("is starting for a partially stopped stack, not stopped", () => {
    // Half-down is not down: a consumer must not conclude "nothing is running".
    assert.equal(stackStatus([service("api", "ready"), service("db", "stopped")]), "starting");
  });
});

describe("markFailedToStart", () => {
  // The bug this exists to prevent: a service that crashes before the first
  // `compose ps` is reported `stopped`, so `waitReady` never watches it, never
  // marks it unhealthy and never attaches its logs. `wt up` then exits 0 with
  // status `starting` — apparent success for a broken stack.
  it("treats a container that failed to start as starting, so it gets watched", () => {
    const runtime = [service("api", "stopped"), service("db", "ready")];
    markFailedToStart(runtime, new Set(), null);
    assert.equal(runtime[0]?.status, "starting");
  });

  it("leaves a service alone that was already stopped and was not asked for", () => {
    // `wt up api` must not declare a `web` you stopped yesterday to be broken.
    const runtime = [service("api", "starting"), service("web", "stopped")];
    markFailedToStart(runtime, new Set(["web"]), new Set(["api"]));
    assert.equal(runtime[1]?.status, "stopped");
  });

  it("catches a service that was running before this call and is not now", () => {
    // Not asked for, but it did not stop on its own — something killed it.
    const runtime = [service("api", "starting"), service("web", "stopped")];
    markFailedToStart(runtime, new Set(), new Set(["api"]));
    assert.equal(runtime[1]?.status, "starting");
  });

  it("never touches a service with no container at all", () => {
    const runtime = [service("web", "not-started")];
    markFailedToStart(runtime, new Set(), null);
    assert.equal(runtime[0]?.status, "not-started");
  });
});

describe("buildManifest", () => {
  const runtime = [
    service("web", "not-started", {
      config: { name: "web", layer: "frontend", runtime: "compose", health: { kind: "http", path: "/healthz" }, subdomain: "web", port: 3000 },
      url: "http://web.fix-billing.localtest.me:8081",
    }),
    service("api", "ready", {
      config: { name: "api", layer: "backend", runtime: "compose", health: { kind: "http", path: "/healthz" }, subdomain: "api", port: 4000 },
      url: "http://api.fix-billing.localtest.me:8081",
      internalUrl: "http://api.internal:4000",
    }),
    service("db", "ready", {
      config: { name: "db", layer: "data", runtime: "compose", health: { kind: "exec", command: ["pg_isready"] }, hostPort: true },
      hostAddress: "localhost:23229",
    }),
  ];

  it("derives scope from what is running, not from what is declared", () => {
    const manifest = buildManifest(ctx, runtime);
    assert.deepEqual(manifest.scope, ["api", "db"]);
    assert.equal(manifest.status, "ready");
  });

  it("keeps not-started services in the list so a consumer can see they exist", () => {
    const manifest = buildManifest(ctx, runtime);
    const web = manifest.services.find((s) => s.name === "web");
    assert.equal(web?.status, "not-started");
    assert.equal(manifest.services.length, 3);
  });

  it("promotes the frontend URL to baseUrl and the backend URL to apiUrl", () => {
    const manifest = buildManifest(ctx, runtime);
    assert.equal(manifest.baseUrl, "http://web.fix-billing.localtest.me:8081");
    assert.equal(manifest.apiUrl, "http://api.fix-billing.localtest.me:8081");
  });

  it("falls back to the first service with a URL when there is no frontend", () => {
    const manifest = buildManifest(ctx, runtime.slice(1));
    assert.equal(manifest.baseUrl, "http://api.fix-billing.localtest.me:8081");
  });

  it("renders health as the probe path, the check kind, or null", () => {
    const manifest = buildManifest(ctx, runtime);
    assert.equal(manifest.services.find((s) => s.name === "api")?.health, "/healthz");
    assert.equal(manifest.services.find((s) => s.name === "db")?.health, "exec");
  });

  it("prefixes declared commands with `wt run` so they are copy-pasteable", () => {
    assert.deepEqual(buildManifest(ctx, runtime).commands, { e2e: "wt run node e2e.mjs" });
  });

  it("attaches logs to a failed service so the failure explains itself", () => {
    const failed = [service("api", "unhealthy", { lastLogs: ["Error: connect ECONNREFUSED"] })];
    const manifest = buildManifest(ctx, failed);
    assert.equal(manifest.status, "unhealthy");
    assert.deepEqual(manifest.services[0]?.lastLogs, ["Error: connect ECONNREFUSED"]);
  });

  it("omits lastLogs on healthy services", () => {
    const manifest = buildManifest(ctx, runtime);
    assert.ok(manifest.services.every((s) => s.lastLogs === undefined));
  });
});
