import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, loadConfig } from "../../src/core/config.js";
import { cleanup, tmpDir, write } from "../helpers.js";

after(cleanup);

const MINIMAL = `
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "api"
port = 4000
subdomain = "api"
health = "/healthz"
`;

async function load(toml: string) {
  const dir = await tmpDir("config");
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

describe("loadConfig", () => {
  it("applies the documented defaults", async () => {
    const config = await load(MINIMAL);
    assert.equal(config.domain, "localtest.me");
    assert.equal(config.proxy.port, 80);
    assert.equal(config.proxy.network, "wt-proxy");
    // Traefik < 3.6 cannot talk to Docker Engine 29+ and serves 404 for
    // everything with no error anywhere but its own container logs.
    assert.equal(config.proxy.image, "traefik:v3.6");
    assert.equal(config.healthTimeoutMs, 120_000);
  });

  it("defaults the layer to backend and the health check to none", async () => {
    const config = await load(`
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "worker"
`);
    assert.equal(config.services[0]?.layer, "backend");
    assert.deepEqual(config.services[0]?.health, { kind: "none" });
  });

  it("parses each health-check form", async () => {
    const config = await load(`
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "api"
subdomain = "api"
port = 4000
health = "/healthz"

[[services]]
name = "db"
host_port = true
health = { exec = ["pg_isready", "-U", "app"] }

[[services]]
name = "cache"
host_port = true
health = { tcp = true }
`);
    assert.deepEqual(config.services[0]?.health, { kind: "http", path: "/healthz" });
    assert.deepEqual(config.services[1]?.health, { kind: "exec", command: ["pg_isready", "-U", "app"] });
    assert.deepEqual(config.services[2]?.health, { kind: "tcp" });
  });

  it("rejects an HTTP health check with no URL to probe", async () => {
    // The failure this prevents is silent: without a subdomain there is no URL,
    // so the probe can never succeed and the service hangs until the timeout.
    await rejects(
      `
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "api"
port = 4000
health = "/healthz"
`,
      /no subdomain/,
    );
  });

  it("rejects a TCP health check with no host port to connect to", async () => {
    await rejects(
      `
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "db"
health = { tcp = true }
`,
      /host_port is not set/,
    );
  });

  it("rejects a subdomain with no container port for the proxy to forward to", async () => {
    await rejects(
      `
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "api"
subdomain = "api"
`,
      /no port/,
    );
  });

  it("rejects a group naming a service that does not exist", async () => {
    await rejects(MINIMAL + '\n[groups]\nbackend = ["api", "ghost"]\n', /unknown service "ghost"/);
  });

  it("rejects duplicate service names", async () => {
    await rejects(MINIMAL + '\n[[services]]\nname = "api"\n', /Duplicate service "api"/);
  });

  it("rejects an unknown layer, listing the valid ones", async () => {
    await rejects(
      `
[project]
name = "demo"
compose = ["docker-compose.yml"]

[[services]]
name = "api"
layer = "middleware"
`,
      /must be one of frontend, backend, worker, data, infra/,
    );
  });

  it("requires at least one service", async () => {
    // An empty project.compose is legitimate - see the host-services suite - but
    // a config declaring no services at all describes no stack.
    await rejects(`[project]\nname = "demo"\ncompose = ["docker-compose.yml"]\n`, /At least one \[\[services\]\]/);
  });

  it("names the offending key when a value has the wrong type", async () => {
    await rejects(`[project]\nname = 3\ncompose = ["x.yml"]\n`, /project\.name must be a string/);
  });

  it("says where to look when there is no config at all", async () => {
    const dir = await tmpDir("config-empty");
    await assert.rejects(loadConfig(dir), /No worktree\.toml found/);
  });

  it("parses the hydration section", async () => {
    const config = await load(
      MINIMAL +
        `
[hydrate]
copy = [".env", "apps/*/.env.local"]
link = ["node_modules"]
run = ["pnpm install --frozen-lockfile"]
`,
    );
    assert.deepEqual(config.hydrate.copy, [".env", "apps/*/.env.local"]);
    assert.deepEqual(config.hydrate.link, ["node_modules"]);
    assert.deepEqual(config.hydrate.run, ["pnpm install --frozen-lockfile"]);
    assert.deepEqual(config.hydrate.lockfiles, []);
  });

  it("defaults hooks to reporting on start and doing nothing on end", async () => {
    // `SessionEnd` cannot ask a question, so nothing destructive may be automated
    // there; even the reversible `down` has to be opted into.
    const config = await load(MINIMAL);
    assert.equal(config.hooks.onSessionStart, "status");
    assert.equal(config.hooks.onSessionEnd, "off");
  });

  it("rejects a hook action it does not implement", async () => {
    await rejects(MINIMAL + '\n[hooks]\non_session_end = "rm"\n', /must be "off" or "down"/);
  });
});

describe("[seed]", () => {
  it("defaults to copying nothing, so a stack that seeds itself is never asked", async () => {
    const config = await load(MINIMAL);
    assert.equal(config.seed.from, null);
  });

  it("takes the worktree to copy from", async () => {
    const config = await load(`${MINIMAL}\n[seed]\nfrom = "main"\n`);
    assert.equal(config.seed.from, "main");
  });

  it("rejects an empty source rather than silently doing nothing", async () => {
    // `from = ""` reads as "configured", so treating it as absent would leave
    // someone waiting for a copy that was never going to happen.
    await rejects(`${MINIMAL}\n[seed]\nfrom = ""\n`, /seed\.from is empty/);
  });

  it("rejects a misspelled key", async () => {
    await rejects(`${MINIMAL}\n[seed]\nfrom_worktree = "main"\n`, /from_worktree/);
  });
});
