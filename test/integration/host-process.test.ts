import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanup, git, makeRepo, read, readJsonFile, runCli, tmpDir, write } from "../helpers.js";
import { isAlive } from "../../src/core/processes.js";
import type { Manifest } from "../../src/types.js";

after(cleanup);

/**
 * The end-to-end claim for a stack Docker does not run: one command leases a
 * port, writes it into config the app reads, launches the app, and waits until
 * it answers. No Docker anywhere in this suite.
 */
describe("host processes", () => {
  /** A repo whose whole "stack" is a Node server reading its port from a file. */
  async function hostRepo(label: string): Promise<{ repo: string; home: string }> {
    const repo = await makeRepo(label);
    const home = await tmpDir("home");

    await write(
      path.join(repo, "server.mjs"),
      [
        "import http from 'node:http';",
        "import fs from 'node:fs';",
        // Exactly the shape the real case has: the port comes from a generated
        // config file, not from an argument.
        "const cfg = JSON.parse(fs.readFileSync('generated/ports.json', 'utf8'));",
        "http.createServer((_, res) => res.end('ok')).listen(cfg.port);",
      ].join("\n"),
    );

    await write(
      path.join(repo, "worktree.toml"),
      [
        "[project]",
        'name = "host-only"',
        "compose = []",
        "",
        "[[services]]",
        'name = "api"',
        'runtime = "host"',
        'start = "node server.mjs"',
        "health = { tcp = true }",
        "",
        "[render]",
        '"generated/ports.json" = """',
        '{ "port": ${WT_PORT_API} }',
        '"""',
      ].join("\n"),
    );
    await write(path.join(repo, ".gitignore"), ".wt/\ngenerated/\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "host-only stack"]);
    return { repo, home };
  }

  it("leases a port, renders it, starts the process and waits for it", async () => {
    const { repo, home } = await hostRepo("host-up");
    try {
      const result = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      assert.equal(result.code, 0, result.stdout + result.stderr);

      const manifest = result.json<Manifest>();
      assert.equal(manifest.status, "ready", "the process answered on its leased port");

      const api = manifest.services.find((s) => s.name === "api");
      assert.equal(api?.status, "ready");
      assert.match(api?.hostAddress ?? "", /^localhost:2\d{4}$/);

      // The generated file is what the process actually read.
      const cfg = await readJsonFile<{ port: number }>(path.join(repo, "generated", "ports.json"));
      assert.equal(`localhost:${cfg.port}`, api?.hostAddress);

      // And it is genuinely serving on it.
      const res = await fetch(`http://${api?.hostAddress}/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(await res.text(), "ok");
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });

  it("stops the process on down, and the port is free again", async () => {
    const { repo, home } = await hostRepo("host-down");
    await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });

    const pid = (await readJsonFile<Record<string, { pid: number }>>(
      path.join(repo, ".wt", "processes.json"),
    )).api?.pid;
    assert.ok(pid, "a pid was recorded");
    assert.equal(isAlive(pid), true);

    const down = await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    assert.equal(down.code, 0, down.stderr);

    // The ledger is cleared and the process is gone - `down` on a host stack has
    // to actually stop something, or it silently does nothing at all.
    const ledger = await readJsonFile<Record<string, unknown>>(
      path.join(repo, ".wt", "processes.json"),
    );
    assert.deepEqual(ledger, {});
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(isAlive(pid), false);
  });

  it("does not start a second copy when one is already running", async () => {
    // `grove up` is meant to be safe to run whenever you are unsure. A second
    // process fighting the first over the port is the worst possible answer.
    const { repo, home } = await hostRepo("host-idempotent");
    try {
      await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const first = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;

      const again = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      assert.equal(again.json<Manifest>().status, "ready");

      const second = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;
      assert.equal(second, first, "the same process is still the one running");
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });

  it("reports a process that dies, with its own output attached", async () => {
    const { repo, home } = await hostRepo("host-crash");
    await write(path.join(repo, "server.mjs"), "console.error('boom from the fixture');\nprocess.exit(1);\n");
    await git(repo, ["commit", "-qam", "break it"]);

    const result = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
    await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });

    assert.equal(result.code, 1);
    const manifest = result.json<Manifest>();
    assert.equal(manifest.status, "unhealthy");

    const api = manifest.services.find((s) => s.name === "api");
    assert.equal(api?.status, "unhealthy");
    // Its stdout/stderr, captured - there is no `docker logs` to fall back on.
    assert.ok(
      api?.lastLogs?.some((l) => /boom from the fixture/.test(l)),
      `logs were: ${JSON.stringify(api?.lastLogs)}`,
    );
  });

  it("shows a host process's output through grove logs", async () => {
    const { repo, home } = await hostRepo("host-logs");
    try {
      await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const logs = await runCli(["logs", "api", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
      assert.equal(logs.code, 0, logs.stderr);
      assert.deepEqual(logs.json<{ services: string[] }>().services, ["api"]);
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });

  it("does not call a crashed service ready because something else holds its port", async () => {
    // Leases are deterministic, so the port a fresh worktree gets is exactly the
    // one an orphan from a previous run is most likely to be sitting on. Found
    // this way: a stack that exited on startup reported `ready`, against a
    // stranger's socket.
    const { repo, home } = await hostRepo("host-squatter");
    const { createServer } = await import("node:net");

    // Take the lease first so we know which port to squat on.
    await runCli(["status", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    const manifest = await readJsonFile<Manifest>(path.join(repo, ".wt", "manifest.json"));
    const port = Number(manifest.services[0]?.hostAddress?.split(":").pop());

    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));

    try {
      await write(path.join(repo, "server.mjs"), "process.exit(1);\n");
      const result = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });

      assert.equal(result.code, 1, "a crashed process is not ready, whoever holds the port");
      assert.equal(result.json<Manifest>().services[0]?.status, "unhealthy");
    } finally {
      squatter.close();
    }
  });

  it("does not accuse its own corpse of squatting when it restarts", async () => {
    // The guard that catches an orphan on a leased port has one blind spot: the
    // moment just after `up` killed the previous process itself. A socket can
    // outlive the process that held it, and the guard cannot tell that socket
    // from a stranger's - so it reported "not by a process this worktree
    // started" about a process this worktree had started and stopped one line
    // earlier, and told the user to hunt an orphan that did not exist.
    //
    // Simulated here with a real squatter, which is the same input the guard
    // sees. The restart must still be attempted; the truthful failure is the
    // process saying it could not bind, in its own log.
    const { repo, home } = await hostRepo("host-corpse");
    const { createServer } = await import("node:net");

    await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
    const manifest = await readJsonFile<Manifest>(path.join(repo, ".wt", "manifest.json"));
    const port = Number(manifest.services[0]?.hostAddress?.split(":").pop());

    const toml = await read(path.join(repo, "worktree.toml"));
    await write(
      path.join(repo, "worktree.toml"),
      toml.replace('{ "port": ${WT_PORT_API} }', '{ "port": ${WT_PORT_API}, "extra": 1 }'),
    );

    // Take the port the instant the old process lets go of it.
    const squatter = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        squatter.once("error", reject);
        squatter.listen(port, "127.0.0.1", () => resolve());
      }).catch(() => {
        // The old process still holds it, which is the same situation from the
        // guard's point of view. Either way the assertion below is the point.
      });

      const again = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const logs = (again.json<Manifest>().services[0]?.lastLogs ?? []).join(" ");
      assert.doesNotMatch(
        logs,
        /not by a process this worktree started/,
        "it blamed an orphan for a process it had just stopped itself",
      );
    } finally {
      squatter.close();
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });

  it("restarts a running process when its generated config changed", async () => {
    // `grove up` is a no-op on a live stack, which meant editing worktree.toml and
    // re-running it silently kept serving the old ports: the change looked
    // applied and was not. Observed on a real repo.
    const { repo, home } = await hostRepo("host-reconfig");
    try {
      await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const before = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;

      // Change what the template renders, so the file on disk differs.
      const toml = await read(path.join(repo, "worktree.toml"));
      await write(
        path.join(repo, "worktree.toml"),
        toml.replace('{ "port": ${WT_PORT_API} }', '{ "port": ${WT_PORT_API}, "extra": 1 }'),
      );

      const again = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      assert.equal(again.json<Manifest>().status, "ready");

      const after = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;
      assert.notEqual(after, before, "it should have been restarted to read the new config");
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });

  it("does not restart when the config is unchanged", async () => {
    const { repo, home } = await hostRepo("host-noreconfig");
    try {
      await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const before = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;

      await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      const after = (await readJsonFile<Record<string, { pid: number }>>(
        path.join(repo, ".wt", "processes.json"),
      )).api?.pid;
      assert.equal(after, before);
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
    }
  });
});

/**
 * The claim that makes several worktrees usable at once: stopping one leaves the
 * others alone. Asserted rather than reasoned about, because the reasoning is
 * exactly the kind that has been wrong before - containers are addressed by the
 * Compose project name and processes by a per-worktree ledger, and both of those
 * are one refactor away from leaking.
 *
 * No Docker here on purpose: host processes are the harder case, since they are
 * ordinary OS processes with nothing namespacing them.
 */
describe("stopping one worktree leaves the others running", () => {
  async function twoWorktrees(label: string) {
    const repo = await makeRepo(label);
    const home = await tmpDir("home");

    await write(
      path.join(repo, "server.mjs"),
      [
        "import http from 'node:http';",
        "import fs from 'node:fs';",
        "const cfg = JSON.parse(fs.readFileSync('generated/ports.json', 'utf8'));",
        "http.createServer((_, res) => res.end('ok')).listen(cfg.port);",
      ].join("\n"),
    );
    await write(
      path.join(repo, "worktree.toml"),
      [
        "[project]",
        'name = "two-up"',
        "compose = []",
        "",
        "[[services]]",
        'name = "api"',
        'runtime = "host"',
        'start = "node server.mjs"',
        "health = { tcp = true }",
        "",
        "[render]",
        '"generated/ports.json" = """',
        '{ "port": ${WT_PORT_API} }',
        '"""',
      ].join("\n"),
    );
    await write(path.join(repo, ".gitignore"), ".wt/\ngenerated/\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "two-up"]);

    const created = await runCli(["new", "feat/second", "--json"], {
      cwd: repo,
      home,
      timeoutMs: 120_000,
    });
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const second = created.json<{ worktree: { root: string } }>().worktree.root;

    const first = await runCli(["up", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
    assert.equal(first.json<Manifest>().status, "ready");

    return { repo, second, home };
  }

  const pidOf = async (root: string) =>
    (await readJsonFile<Record<string, { pid: number }>>(path.join(root, ".wt", "processes.json")))
      .api?.pid;

  it("down in one worktree does not stop the other", async () => {
    const { repo, second, home } = await twoWorktrees("two-down");
    try {
      const firstPid = await pidOf(repo);
      const secondPid = await pidOf(second);
      assert.ok(firstPid && secondPid, "both worktrees started a process");
      assert.notEqual(firstPid, secondPid, "they are genuinely separate processes");

      const down = await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
      assert.equal(down.code, 0, down.stderr);
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(isAlive(firstPid!), false, "the worktree we stopped is stopped");
      assert.equal(isAlive(secondPid!), true, "the OTHER worktree is untouched");

      // And still serving, not merely alive.
      const status = await runCli(["status", "--json"], { cwd: second, home, timeoutMs: 60_000 });
      assert.equal(status.json<Manifest>().status, "ready");
    } finally {
      await runCli(["down", "--json"], { cwd: second, home, timeoutMs: 60_000 }).catch(() => {});
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 }).catch(() => {});
    }
  });

  it("restart in one worktree does not touch the other", async () => {
    const { repo, second, home } = await twoWorktrees("two-restart");
    try {
      const otherBefore = await pidOf(second);

      const result = await runCli(["restart", "--json"], { cwd: repo, home, timeoutMs: 120_000 });
      assert.equal(result.code, 0, result.stdout + result.stderr);

      assert.equal(await pidOf(second), otherBefore, "the other worktree's process was never restarted");
      assert.equal(isAlive(otherBefore!), true);
    } finally {
      await runCli(["down", "--json"], { cwd: second, home, timeoutMs: 60_000 }).catch(() => {});
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 }).catch(() => {});
    }
  });

  it("rm of one worktree leaves the other running", async () => {
    // The destructive command, and the one where a mistake is unrecoverable.
    const { repo, second, home } = await twoWorktrees("two-rm");
    try {
      const keepPid = await pidOf(repo);

      const removed = await runCli(["rm", "feat-second", "--force", "--json"], {
        cwd: repo,
        home,
        timeoutMs: 120_000,
      });
      assert.equal(removed.code, 0, removed.stdout + removed.stderr);

      assert.equal(isAlive(keepPid!), true, "the worktree we kept is still running");
      const status = await runCli(["status", "--json"], { cwd: repo, home, timeoutMs: 60_000 });
      assert.equal(status.json<Manifest>().status, "ready");
    } finally {
      await runCli(["down", "--json"], { cwd: repo, home, timeoutMs: 60_000 }).catch(() => {});
    }
  });
});
