import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  cleanup,
  dockerTests,
  git,
  makeRepo,
  read,
  runCli,
  teardown,
  tmpDir,
  write,
} from "../helpers.js";
import type { Manifest } from "../../src/types.js";

after(cleanup);

/**
 * The tests that need Docker.
 *
 * Everything M1 got wrong presented as apparent success — a port silently not
 * published, a proxy answering 404 with no error anywhere, one worktree driving
 * another's containers. None of that is observable without actually booting the
 * thing, so these exist even though they are slow.
 *
 * Enable with `WT_TEST_DOCKER=1 npm test`. Expect several minutes on a cold
 * image cache.
 */
describe("stack", { skip: dockerTests ? false : "set WT_TEST_DOCKER=1 to run Docker tests" }, () => {
  const TIMEOUT = 300_000;

  /**
   * Each test gets its own branch, and therefore its own slug, Compose project,
   * container names and port leases. Two tests on `main` would drive one set of
   * containers — and so would any real worktree of the user's called `main`.
   */
  async function bootedRepo(label: string): Promise<{ repo: string; home: string; slug: string }> {
    const slug = `wt-test-${label}`;
    const repo = await makeRepo(label, slug);
    const home = await tmpDir("home");
    return { repo, home, slug };
  }

  it("brings a stack up and reports every layer ready", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-up");
    try {
      const result = await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.equal(result.code, 0, result.stdout + result.stderr);

      const manifest = result.json<Manifest>();
      assert.equal(manifest.status, "ready");
      assert.deepEqual([...manifest.scope].sort(), ["api", "db", "web"]);
      assert.equal(manifest.baseUrl, `http://web.${slug}.localtest.me:8081`);

      // The manifest is written inside the worktree, so an agent's relative read
      // resolves without knowing which worktree it is in.
      const onDisk = JSON.parse(await read(path.join(repo, ".wt", "manifest.json"))) as Manifest;
      assert.equal(onDisk.status, "ready");

      // The database is reachable on a leased host port, not on 5432.
      const db = manifest.services.find((s) => s.name === "db");
      assert.match(db?.hostAddress ?? "", /^localhost:2\d{4}$/);
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("passes an e2e run through the proxy, the frontend, the api and the database", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-e2e");
    try {
      await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });

      const result = await runCli(["run", "node", "e2e.mjs"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /e2e passed/);
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("runs two worktrees at once on identical internal ports", { timeout: TIMEOUT }, async () => {
    // The claim the whole design rests on: ports collide only on the host, so two
    // stacks can both run web:3000 / api:4000 / db:5432 and never meet.
    const { repo, home, slug } = await bootedRepo("stack-two");
    let second = "";
    try {
      const created = await runCli(["new", "fix/billing", "--build", "--json"], {
        cwd: repo,
        home,
        timeoutMs: TIMEOUT,
      });
      assert.equal(created.code, 0, created.stdout + created.stderr);
      second = created.json<{ worktree: { root: string } }>().worktree.root;

      const first = await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.equal(first.json<Manifest>().status, "ready");

      // Each e2e asserts it was served by its own worktree, which is what proves
      // the two stacks are not sharing containers.
      for (const cwd of [repo, second]) {
        const e2e = await runCli(["run", "node", "e2e.mjs"], { cwd, home, timeoutMs: TIMEOUT });
        assert.equal(e2e.code, 0, `${cwd}: ${e2e.stdout}${e2e.stderr}`);
      }

      const a = await runCli(["status", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      const b = await runCli(["status", "--json"], { cwd: second, home, timeoutMs: TIMEOUT });
      assert.notEqual(a.json<Manifest>().baseUrl, b.json<Manifest>().baseUrl);
      assert.notEqual(
        a.json<Manifest>().services.find((s) => s.name === "db")?.hostAddress,
        b.json<Manifest>().services.find((s) => s.name === "db")?.hostAddress,
      );
    } finally {
      if (second) await runCli(["rm", "fix-billing", "--force", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      await teardown(repo, slug, home);
    }
  });

  it("starts a subset and reports the rest as not-started, not broken", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-partial");
    try {
      const result = await runCli(["up", "--group", "backend", "--build", "--json"], {
        cwd: repo,
        home,
        timeoutMs: TIMEOUT,
      });

      const manifest = result.json<Manifest>();
      assert.equal(manifest.status, "ready", "a partial stack is ready when its scope is ready");
      assert.deepEqual([...manifest.scope].sort(), ["api", "db"]);
      assert.equal(manifest.services.find((s) => s.name === "web")?.status, "not-started");

      // Adding a service later extends the scope without restarting the rest.
      const added = await runCli(["up", "web", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.deepEqual([...added.json<Manifest>().scope].sort(), ["api", "db", "web"]);
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("fails fast on a service that crashes, with its logs attached", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-crash");
    try {
      await write(path.join(repo, "api", "server.js"), 'throw new Error("boom from the fixture");\n');
      await git(repo, ["commit", "-qam", "break the api"]);

      const started = Date.now();
      const result = await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      const elapsed = Date.now() - started;

      assert.equal(result.code, 1);
      const manifest = result.json<Manifest>();
      assert.equal(manifest.status, "unhealthy");

      const api = manifest.services.find((s) => s.name === "api");
      assert.equal(api?.status, "unhealthy");
      // The real application error, inline — not "timed out waiting for api".
      assert.ok(api?.lastLogs?.some((l) => /boom from the fixture/.test(l)), api?.lastLogs?.join("\n"));

      // A dead container will never become healthy, so waiting out the full
      // health timeout is pure waste.
      assert.ok(elapsed < 120_000, `took ${elapsed}ms — it burned the health timeout`);
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("refuses to run against a stack that is not ready", { timeout: TIMEOUT }, async () => {
    // Nothing is started here, so there is nothing to tear down.
    const { repo, home } = await bootedRepo("stack-refuse");
    const result = await runCli(["run", "--json", "node", "e2e.mjs"], { cwd: repo, home, timeoutMs: TIMEOUT });

    assert.equal(result.code, 1);
    const payload = result.json<{ ok: boolean; error: string; hint: string }>();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /refusing to run/);
    assert.match(payload.hint, /wt up/);
  });

  it("passes the child's exit code through", { timeout: TIMEOUT }, async () => {
    // Without this a failing e2e suite reads as a pass to every caller.
    const { repo, home, slug } = await bootedRepo("stack-exit");
    try {
      await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      const result = await runCli(["run", "node", "-e", "process.exit(42)"], {
        cwd: repo,
        home,
        timeoutMs: TIMEOUT,
      });
      assert.equal(result.code, 42);
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("injects the worktree's environment, including the leased database URL", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-env");
    try {
      await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      const result = await runCli(["status", "--env", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });

      const env = result.json<Record<string, string>>();
      assert.equal(env.WT_NAME, slug);
      assert.match(env.DATABASE_URL ?? "", /^postgres:\/\/app:app@localhost:2\d{4}\/app$/);
      assert.match(env.BASE_URL ?? "", new RegExp(`^http://web\.${slug}\.`));
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("survives `down` and comes back with its data", { timeout: TIMEOUT }, async () => {
    const { repo, home, slug } = await bootedRepo("stack-cycle");
    try {
      await runCli(["up", "--build", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      const leasedBefore = (await runCli(["status", "--json"], { cwd: repo, home })).json<Manifest>()
        .services.find((s) => s.name === "db")?.hostAddress;

      const stopped = await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.equal(stopped.code, 0);
      assert.notEqual(stopped.json<Manifest>().status, "ready");

      const restarted = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });
      assert.equal(restarted.json<Manifest>().status, "ready");
      // The lease is authoritative and must not be renumbered on every up.
      assert.equal(
        restarted.json<Manifest>().services.find((s) => s.name === "db")?.hostAddress,
        leasedBefore,
      );
    } finally {
      await teardown(repo, slug, home);
    }
  });

  it("checks the environment and the migration", { timeout: TIMEOUT }, async () => {
    // Read-only, and starts nothing.
    const { repo, home } = await bootedRepo("stack-doctor");
    const result = await runCli(["doctor", "--json"], { cwd: repo, home, timeoutMs: TIMEOUT });

    const report = result.json<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>();
    const failed = report.checks.filter((ch) => !ch.ok);
    assert.deepEqual(failed, [], `failing checks: ${failed.map((f) => `${f.name} (${f.detail})`).join(", ")}`);
  });
});
