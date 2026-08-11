import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, loadConfig } from "../../src/core/config.js";
import { buildRuntime, probeHosts } from "../../src/core/health.js";
import { buildManifest, stackStatus } from "../../src/core/manifest.js";
import type { Context } from "../../src/core/context.js";
import { cleanup, tmpDir, write } from "../helpers.js";

after(cleanup);

const BASE = `
[project]
name = "host-only"
compose = ["docker-compose.yml"]
`;

async function load(toml: string) {
  const dir = await tmpDir("host-config");
  await write(path.join(dir, "worktree.toml"), toml);
  return loadConfig(dir);
}

async function rejects(toml: string, pattern: RegExp) {
  await assert.rejects(load(toml), (err: unknown) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    assert.match((err as Error).message, pattern);
    return true;
  });
}

describe('runtime = "host" config', () => {
  it("defaults to compose when unspecified", async () => {
    const config = await load(BASE + '\n[[services]]\nname = "api"\n');
    assert.equal(config.services[0]?.runtime, "compose");
  });

  it("implies a port lease, because that is the only thing wt can own", async () => {
    const config = await load(BASE + '\n[[services]]\nname = "api-grpc"\nruntime = "host"\n');
    assert.equal(config.services[0]?.runtime, "host");
    assert.equal(config.services[0]?.hostPort, true);
  });

  it("rejects a subdomain, because the proxy routes to containers", async () => {
    await rejects(
      BASE + '\n[[services]]\nname = "gateway"\nruntime = "host"\nsubdomain = "gateway"\nport = 5008\n',
      /cannot have a subdomain/,
    );
  });

  it("rejects a container port, which has no meaning off Compose", async () => {
    await rejects(
      BASE + '\n[[services]]\nname = "gateway"\nruntime = "host"\nport = 5008\n',
      /`port` has no meaning/,
    );
  });

  it("rejects exec and http health checks", async () => {
    await rejects(
      BASE + '\n[[services]]\nname = "gateway"\nruntime = "host"\nhealth = { exec = ["true"] }\n',
      /must be \{ tcp = true \} or/,
    );
  });

  it("accepts a TCP health check", async () => {
    const config = await load(
      BASE + '\n[[services]]\nname = "gateway"\nruntime = "host"\nhealth = { tcp = true }\n',
    );
    assert.deepEqual(config.services[0]?.health, { kind: "tcp" });
  });

  it("names the valid values when given something else", async () => {
    await rejects(
      BASE + '\n[[services]]\nname = "x"\nruntime = "podman"\n',
      /must be "compose" or "host"/,
    );
  });
});

describe("[render] config", () => {
  it("reads templates keyed by path", async () => {
    const config = await load(BASE + '\n[[services]]\nname = "api"\n\n[render]\n"a/b.json" = "{}"\n');
    assert.deepEqual(config.render, { "a/b.json": "{}" });
  });

  it("refuses to write outside the worktree", async () => {
    // A generated file is written on every `wt up`; escaping the worktree would
    // make one worktree quietly overwrite another's config.
    await rejects(
      BASE + '\n[[services]]\nname = "api"\n\n[render]\n"../outside.json" = "{}"\n',
      /no absolute paths, no ".."/,
    );
  });

  it("defaults to nothing", async () => {
    const config = await load(BASE + '\n[[services]]\nname = "api"\n');
    assert.deepEqual(config.render, {});
  });
});

/* ── runtime behaviour ────────────────────────────────────────────────────── */

function contextWith(services: { name: string; runtime: "compose" | "host" }[], leases: Record<string, number> = {}): Context {
  return {
    root: "/repo",
    slug: "feat-x",
    branch: "feat/x",
    leases,
    config: {
      project: { name: "demo", compose: ["docker-compose.yml"] },
      domain: "localtest.me",
      proxy: { port: 8081, network: "wt-proxy", image: "traefik:v3.6" },
      services: services.map((s) => ({
        name: s.name,
        layer: "backend" as const,
        runtime: s.runtime,
        health: { kind: "none" as const },
        ...(s.runtime === "host" ? { hostPort: true } : {}),
      })),
      groups: {},
      commands: {},
      env: {},
      healthTimeoutMs: 120_000,
      hydrate: { copy: [], link: [], run: [], lockfiles: [] },
      hooks: { onSessionStart: "status" as const, onSessionEnd: "off" as const },
      render: {},
    },
  };
}

/** A listener on an ephemeral port, so the TCP probe has something real to find. */
function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("host services at runtime", () => {
  it("is not-started when nothing is listening, never unhealthy", async () => {
    // `wt` did not start it and cannot start it, so calling it unhealthy would
    // make `wt up` fail over a process the developer simply has not launched.
    const ctx = contextWith([{ name: "gateway", runtime: "host" }], { gateway: 1 });
    const runtime = buildRuntime(ctx, []);
    await probeHosts(ctx, runtime);
    assert.equal(runtime[0]?.status, "not-started");
  });

  it("is ready when the leased port answers", async () => {
    const server = await listen();
    try {
      const ctx = contextWith([{ name: "gateway", runtime: "host" }], { gateway: server.port });
      const runtime = buildRuntime(ctx, []);
      await probeHosts(ctx, runtime);
      assert.equal(runtime[0]?.status, "ready");
    } finally {
      server.close();
    }
  });

  it("advertises its leased host address", () => {
    const ctx = contextWith([{ name: "gateway", runtime: "host" }], { gateway: 22937 });
    const runtime = buildRuntime(ctx, []);
    assert.equal(runtime[0]?.hostAddress, "localhost:22937");
    // No container, so neither a proxy URL nor an internal one exists.
    assert.equal(runtime[0]?.url, null);
    assert.equal(runtime[0]?.internalUrl, null);
  });

  it("never blocks the stack from being ready", async () => {
    // The property the whole design rests on: a stack whose containers are up is
    // usable even though the developer has not launched the host processes yet.
    const ctx = contextWith(
      [{ name: "db", runtime: "compose" }, { name: "gateway", runtime: "host" }],
      { gateway: 1 },
    );
    const runtime = buildRuntime(ctx, [{ service: "db", name: "db-1", state: "running", health: "" }]);
    runtime[0]!.status = "ready";
    await probeHosts(ctx, runtime);

    assert.equal(stackStatus(runtime), "ready");
    assert.deepEqual(buildManifest(ctx, runtime).scope, ["db"]);
  });

  it("appears in scope once it is listening", async () => {
    const server = await listen();
    try {
      const ctx = contextWith([{ name: "gateway", runtime: "host" }], { gateway: server.port });
      const runtime = buildRuntime(ctx, []);
      await probeHosts(ctx, runtime);
      assert.deepEqual(buildManifest(ctx, runtime).scope, ["gateway"]);
    } finally {
      server.close();
    }
  });

  it("carries its runtime into the manifest, and offers no logs command", () => {
    const ctx = contextWith([{ name: "gateway", runtime: "host" }], { gateway: 22937 });
    const entry = buildManifest(ctx, buildRuntime(ctx, [])).services[0];
    assert.equal(entry?.runtime, "host");
    assert.equal(entry?.logs, "", "there are no container logs for a process we do not run");
  });

  it("records rendered files in the manifest", () => {
    const ctx = contextWith([{ name: "gateway", runtime: "host" }]);
    const manifest = buildManifest(ctx, buildRuntime(ctx, []), ["the generated config"]);
    assert.deepEqual(manifest.rendered, ["the generated config"]);
  });
});

describe("a repo with nothing containerised", () => {
  it("accepts an empty project.compose when every service is a host process", async () => {
    const config = await load(`
[project]
name = "no-containers"

[[services]]
name = "gateway"
runtime = "host"
`);
    assert.deepEqual(config.project.compose, []);
    assert.equal(config.services[0]?.runtime, "host");
  });

  it("refuses an empty project.compose while a compose service is declared", async () => {
    // Otherwise `docker compose` runs with no -f, searches the working
    // directory, and acts on whatever it happens to find there.
    await rejects(
      `
[project]
name = "mixed"

[[services]]
name = "api"

[[services]]
name = "gateway"
runtime = "host"
`,
      /api is runtime = "compose"/,
    );
  });
});
