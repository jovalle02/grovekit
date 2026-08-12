import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { decideHeuristically, isBrowserVar, rewriteEnv } from "../../src/core/adapt/decide.js";
import { guessKind, type Evidence, type ServiceEvidence } from "../../src/core/adapt/evidence.js";
import { renderConfig, renderOverlay } from "../../src/core/adapt/render.js";
import { REPO_ROOT } from "../helpers.js";

const FIXTURES = path.join(REPO_ROOT, "test", "fixtures");

function evidenceFor(partial: Partial<ServiceEvidence> & { name: string }): ServiceEvidence {
  const ports = partial.ports ?? [];
  const expose = partial.expose ?? [];
  const healthcheck = partial.healthcheck ?? null;
  return {
    image: null,
    build: false,
    environment: {},
    dependsOn: [],
    volumes: [],
    ...partial,
    ports,
    expose,
    healthcheck,
    guess: guessKind(partial.name, partial.image ?? null, partial.build ?? false, ports, expose, healthcheck),
  };
}

describe("guessKind", () => {
  it("recognises a known data image and its port", () => {
    const guess = guessKind("db", "postgres:16-alpine", false, [], [], null);
    assert.equal(guess.kind, "tcp");
    assert.equal(guess.layer, "data");
    assert.equal(guess.port, 5432);
    assert.equal(guess.confidence, "high");
  });

  it("prefers the port the compose file actually declares over the table's default", () => {
    const guess = guessKind("db", "postgres:16", false, [{ published: 5433, target: 5555, protocol: "tcp" }], [], null);
    assert.equal(guess.port, 5555);
  });

  it("treats a healthcheck that requests a URL as proof of HTTP", () => {
    // The single most reliable signal in a compose file: it names the protocol
    // and the health path at once, and it works on any image.
    const guess = guessKind("svc", "acme/svc-7:latest", false, [], [8080], [
      "CMD",
      "curl",
      "-f",
      "http://localhost:8080/healthz",
    ]);
    assert.equal(guess.kind, "http");
    assert.equal(guess.confidence, "high");
  });

  it("classifies an unknown image with a published port as HTTP, not confidently", () => {
    const guess = guessKind("svc", "acme/svc-7:latest", false, [{ published: 9000, target: 9000, protocol: "tcp" }], [], null);
    assert.equal(guess.kind, "http");
    assert.equal(guess.confidence, "medium");
  });

  it("uses the service name only to break a tie the ports cannot", () => {
    assert.equal(guessKind("web", null, true, [{ published: 3000, target: 3000, protocol: "tcp" }], [], null).layer, "frontend");
    assert.equal(guessKind("orders", null, true, [{ published: 3000, target: 3000, protocol: "tcp" }], [], null).layer, "backend");
  });

  it("calls something that listens on nothing a worker", () => {
    const guess = guessKind("cron", "acme/cron", false, [], [], null);
    assert.equal(guess.kind, "worker");
    assert.equal(guess.port, null);
  });
});

describe("decideHeuristically", () => {
  const evidence: Evidence = {
    schemaVersion: 1,
    project: "demo",
    root: "/repo",
    composeFiles: ["docker-compose.yml"],
    containerised: true,
    warnings: [],
    services: [
      evidenceFor({
        name: "web",
        build: true,
        ports: [{ published: 3000, target: 3000, protocol: "tcp" }],
        environment: { API_URL: "http://localhost:4000", NEXT_PUBLIC_API_URL: "http://localhost:4000" },
      }),
      evidenceFor({
        name: "api",
        build: true,
        ports: [{ published: 4000, target: 4000, protocol: "tcp" }],
      }),
      evidenceFor({
        name: "db",
        image: "postgres:16-alpine",
        ports: [{ published: 5432, target: 5432, protocol: "tcp" }],
        environment: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "app", POSTGRES_DB: "shop" },
      }),
    ],
  };

  const decisions = decideHeuristically(evidence);
  const byName = (name: string) => decisions.services.find((s) => s.name === name);

  it("gives every HTTP service a subdomain and no host port", () => {
    assert.equal(byName("web")?.subdomain, "web");
    assert.equal(byName("api")?.subdomain, "api");
    assert.equal(byName("web")?.hostPort, false);
  });

  it("keeps a database reachable from the host, because the base file published it", () => {
    // The conservative rule: if the author published a port, they wanted to reach
    // that thing. Keep it reachable - on a leased port, not a fixed one.
    assert.equal(byName("db")?.hostPort, true);
    assert.equal(byName("db")?.subdomain, null);
    assert.deepEqual(byName("db")?.health, { exec: ["pg_isready", "-h", "127.0.0.1", "-U", "app"] });
  });

  it("checks Postgres over TCP, not over the unix socket", () => {
    // `pg_isready` with no -h talks to the unix socket, and so does the temporary
    // server the official image runs during initdb. The check passed against that
    // bootstrap server, `grove up` reported ready, and the next command got
    // "server closed the connection unexpectedly" as the real server took over.
    // The bootstrap server sets listen_addresses='' - so asking over TCP is the
    // question that cannot be answered early.
    const health = byName("db")?.health as { exec: string[] };
    assert.ok(health.exec.includes("-h"), "the check must name a host");
    assert.equal(health.exec[health.exec.indexOf("-h") + 1], "127.0.0.1");
  });

  it("reuses the credentials the compose file already declares", () => {
    assert.deepEqual(byName("db")?.database, {
      scheme: "postgres",
      user: "app",
      password: "app",
      name: "shop",
    });
  });

  it("flags an assumption that would silently drop a published port", () => {
    assert.ok(decisions.review.some((note) => /web/.test(note)));
  });
});

describe("rewriteEnv", () => {
  const decisions = [
    { name: "api", subdomain: "api", containerPort: 4000 },
    { name: "db", subdomain: null, containerPort: 5432 },
  ] as Parameters<typeof rewriteEnv>[1];

  const rewrite = (environment: Record<string, string>) =>
    rewriteEnv(evidenceFor({ name: "web", environment }), decisions, 8081);

  it("sends a server-to-server URL to the internal alias", () => {
    // Stays inside the Docker network, so it is byte-identical in every worktree.
    // That invariant is the whole reason this design is worth the machinery.
    assert.deepEqual(rewrite({ API_URL: "http://localhost:4000" }), {
      API_URL: "http://api.internal:4000",
    });
  });

  it("sends a browser-facing URL to the external hostname", () => {
    // The browser is not on the Docker network, so this is the one class of value
    // that has to vary per worktree.
    assert.deepEqual(rewrite({ NEXT_PUBLIC_API_URL: "http://localhost:4000" }), {
      NEXT_PUBLIC_API_URL: "http://api.${WT_NAME}.${WT_DOMAIN}:8081",
    });
  });

  it("preserves the path component", () => {
    assert.deepEqual(rewrite({ API_URL: "http://localhost:4000/v2" }), {
      API_URL: "http://api.internal:4000/v2",
    });
  });

  it("rewrites an address already written as the service name", () => {
    assert.deepEqual(rewrite({ API_URL: "http://api:4000" }), {
      API_URL: "http://api.internal:4000",
    });
  });

  it("leaves a real external host alone even when the port matches", () => {
    // `api.stripe.com:4000` is not our api service, whatever the port says.
    assert.deepEqual(rewrite({ API_URL: "http://api.stripe.com:4000" }), {});
  });

  it("leaves a URL alone when no service listens on that port", () => {
    assert.deepEqual(rewrite({ OTHER: "http://localhost:9999" }), {});
  });

  it("ignores values that are not URLs", () => {
    assert.deepEqual(rewrite({ LOG_LEVEL: "debug", PORT: "4000" }), {});
  });
});

describe("isBrowserVar", () => {
  it("knows which prefixes reach a browser", () => {
    for (const name of ["NEXT_PUBLIC_API", "VITE_API", "REACT_APP_API", "PUBLIC_API"]) {
      assert.equal(isBrowserVar(name), true, name);
    }
    for (const name of ["API_URL", "DATABASE_URL", "PUBLICATION"]) {
      assert.equal(isBrowserVar(name), false, name);
    }
  });
});

describe("render", () => {
  // Deterministic code, no model: the same decisions must produce byte-identical
  // files forever, which is the property that makes generated config reviewable.
  it("renders the overlay exactly as recorded", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    const expected = await fs.readFile(path.join(FIXTURES, "expected-overlay.yml"), "utf8");
    assert.equal(renderOverlay(decisions), expected);
  });

  it("renders worktree.toml exactly as recorded", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    const expected = await fs.readFile(path.join(FIXTURES, "expected-worktree.toml"), "utf8");
    assert.equal(renderConfig(decisions), expected);
  });

  it("is a pure function of its input", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    assert.equal(renderOverlay(decisions), renderOverlay(decisions));
  });

  it("cancels published ports on every service that does not need one", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    const overlay = renderOverlay(decisions);
    assert.match(overlay, /ports: !reset \[\]/);
    // `!reset` erases the key and ignores any value given to it, so a leased port
    // must use `!override` or the database publishes nothing at all.
    assert.match(overlay, /ports: !override\n\s+- "\$\{WT_PORT_DB\}:5432"/);

    const directives = overlay.split("\n").filter((l) => /^\s+ports:/.test(l));
    assert.equal(directives.length, 3);
    assert.ok(
      directives.every((l) => /ports: (!reset \[\]|!override)$/.test(l.trim())),
      `a !reset with a value publishes nothing: ${directives.join(" | ")}`,
    );
  });

  it("gives every service an internal alias", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    const overlay = renderOverlay(decisions);
    for (const name of ["api", "db", "web"]) {
      assert.match(overlay, new RegExp(`- ${name}\\.internal`));
    }
  });

  it("puts only ingress services on the shared proxy network", async () => {
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));
    const overlay = renderOverlay(decisions);
    assert.equal(overlay.match(/wt-proxy: \{\}/g)?.length, 2);
  });

  it("produces a config that the config loader accepts", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const { tmpDir, write } = await import("../helpers.js");
    const decisions = JSON.parse(await fs.readFile(path.join(FIXTURES, "decisions.json"), "utf8"));

    const dir = await tmpDir("render");
    await write(path.join(dir, "worktree.toml"), renderConfig(decisions));
    const config = await loadConfig(dir);

    assert.equal(config.services.length, 3);
    assert.equal(config.services.find((s) => s.name === "db")?.hostPort, true);
    assert.match(config.env.DATABASE_URL ?? "", /\$\{WT_HOST_DB\}/);
  });
});
