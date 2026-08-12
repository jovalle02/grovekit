import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanup, git, makeRepo, readJsonFile, runCli, tmpDir, write } from "../helpers.js";
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

    // The ledger is cleared and the process is gone — `down` on a host stack has
    // to actually stop something, or it silently does nothing at all.
    const ledger = await readJsonFile<Record<string, unknown>>(
      path.join(repo, ".wt", "processes.json"),
    );
    assert.deepEqual(ledger, {});
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(isAlive(pid), false);
  });

  it("does not start a second copy when one is already running", async () => {
    // `wt up` is meant to be safe to run whenever you are unsure. A second
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
    // Its stdout/stderr, captured — there is no `docker logs` to fall back on.
    assert.ok(
      api?.lastLogs?.some((l) => /boom from the fixture/.test(l)),
      `logs were: ${JSON.stringify(api?.lastLogs)}`,
    );
  });

  it("shows a host process's output through wt logs", async () => {
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
});
