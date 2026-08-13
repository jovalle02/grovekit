import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { interpolate, renderFiles } from "../../src/core/render.js";
import { isOurBinary } from "../../src/core/bin.js";
import { cleanup, read, tmpDir, write } from "../helpers.js";

after(cleanup);

describe("interpolate", () => {
  it("substitutes the worktree's environment", () => {
    const { text, missing } = interpolate('{"port": ${WT_PORT_DB}}', { WT_PORT_DB: "22937" });
    assert.equal(text, '{"port": 22937}');
    assert.deepEqual(missing, []);
  });

  it("reports an unknown variable instead of emptying it", () => {
    // The output is usually JSON, and `"Port": ` parses nowhere near the typo
    // that caused it. Naming the variable is the whole value here.
    const { text, missing } = interpolate('{"port": ${WT_PORT_NOPE}}', {});
    assert.deepEqual(missing, ["WT_PORT_NOPE"]);
    assert.match(text, /\$\{WT_PORT_NOPE\}/);
  });

  it("lists every missing name once, sorted", () => {
    const { missing } = interpolate("${B} ${A} ${B}", {});
    assert.deepEqual(missing, ["A", "B"]);
  });

  it("leaves text with no placeholders untouched", () => {
    assert.equal(interpolate("plain text", {}).text, "plain text");
  });
});

describe("renderFiles", () => {
  it("writes a file from a template", async () => {
    const root = await tmpDir("render");
    const out = await renderFiles(
      root,
      { "config/ports.json": '{"db": ${WT_PORT_DB}}\n' },
      { WT_PORT_DB: "22937" },
    );

    assert.deepEqual(out, [{ file: "config/ports.json", status: "written" }]);
    assert.equal(await read(path.join(root, "config", "ports.json")), '{"db": 22937}\n');
  });

  it("leaves an unchanged file alone, mtime included", async () => {
    // These paths are exactly what a hot-reloading dev server watches, and
    // `grove status` is run often. Rewriting identical bytes would restart it.
    const root = await tmpDir("render-idempotent");
    const templates = { "ports.json": "${WT_PORT_DB}" };
    await renderFiles(root, templates, { WT_PORT_DB: "1" });

    const before = (await fs.stat(path.join(root, "ports.json"))).mtimeMs;
    const second = await renderFiles(root, templates, { WT_PORT_DB: "1" });
    const after = (await fs.stat(path.join(root, "ports.json"))).mtimeMs;

    assert.equal(second[0]?.status, "unchanged");
    assert.equal(before, after);
  });

  it("rewrites when the value actually changed", async () => {
    const root = await tmpDir("render-changed");
    const templates = { "ports.json": "${WT_PORT_DB}" };
    await renderFiles(root, templates, { WT_PORT_DB: "1" });

    const second = await renderFiles(root, templates, { WT_PORT_DB: "2" });
    assert.equal(second[0]?.status, "written");
    assert.equal(await read(path.join(root, "ports.json")), "2");
  });

  it("fails the file rather than writing a broken one", async () => {
    const root = await tmpDir("render-missing");
    const out = await renderFiles(root, { "ports.json": "${WT_PORT_NOPE}" }, {});

    assert.equal(out[0]?.status, "failed");
    assert.match(out[0]?.reason ?? "", /WT_PORT_NOPE/);
    // Nothing written: a half-interpolated config is worse than none.
    await assert.rejects(fs.stat(path.join(root, "ports.json")));
  });

  it("creates parent directories", async () => {
    const root = await tmpDir("render-nested");
    await renderFiles(root, { "a/b/c.json": "{}" }, {});
    assert.equal(await read(path.join(root, "a", "b", "c.json")), "{}");
  });

  it("returns results sorted, so the manifest is stable", async () => {
    const root = await tmpDir("render-order");
    const out = await renderFiles(root, { "z.json": "1", "a.json": "1", "m.json": "1" }, {});
    assert.deepEqual(out.map((r) => r.file), ["a.json", "m.json", "z.json"]);
  });
});

describe("isOurBinary", () => {
  it("accepts a shim whose text names the package", async () => {
    const dir = await tmpDir("bin-shim");
    const shim = path.join(dir, "grove.cmd");
    await write(shim, '@node "%~dp0\\node_modules\\grove-worktree\\dist\\cli.js" %*\n');
    assert.equal(await isOurBinary(shim), true);
  });

  it("accepts a path inside the package", async () => {
    const dir = await tmpDir("bin-path");
    const file = path.join(dir, "grove-worktree", "dist", "cli.js");
    await write(file, "#!/usr/bin/env node\n");
    assert.equal(await isOurBinary(file), true);
  });

  it("rejects a different program that happens to share the name", async () => {
    // The real case: Windows ships grove.exe (Windows Terminal) on every PATH.
    const dir = await tmpDir("bin-impostor");
    const exe = path.join(dir, "grove.exe");
    await fs.writeFile(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
    assert.equal(await isOurBinary(exe), false);
  });

  it("rejects a path that does not exist", async () => {
    assert.equal(await isOurBinary(path.join(await tmpDir("bin-gone"), "nope")), false);
  });
});

describe("tcpReachable", () => {
  // A Vite dev server binds ::1 only. Probing IPv4 alone reported "not running"
  // for a server that was serving, and the workaround was to delete its health
  // check - the opposite of what a health check is for.
  it("finds a listener bound to IPv6 loopback only", async () => {
    const { tcpReachable } = await import("../../src/core/health.js");
    const net = await import("node:net");

    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "::1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    try {
      assert.equal(await tcpReachable(port), true);
    } finally {
      server.close();
    }
  });

  it("finds a listener bound to IPv4 loopback only", async () => {
    const { tcpReachable } = await import("../../src/core/health.js");
    const net = await import("node:net");

    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    try {
      assert.equal(await tcpReachable(port), true);
    } finally {
      server.close();
    }
  });
});

describe("isPortFree agrees with tcpReachable", () => {
  // These two answer the same question from opposite sides, and they disagreed:
  // leasing asked "can I bind 0.0.0.0" while the guard in `up` asked "does
  // anything answer on loopback". A worktree was handed a port an orphan was
  // already listening on, and then told the port was in use by a stranger - both
  // steps of the tool, one contradicting the other in the same command.
  const listenOn = async (host: string) => {
    const net = await import("node:net");
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    return { server, port };
  };

  for (const host of ["127.0.0.1", "::1", "0.0.0.0"]) {
    it(`calls a port busy when something listens on ${host}`, async () => {
      const { isPortFree, tcpReachable } = await import("../../src/core/net.js");
      const { server, port } = await listenOn(host);

      try {
        assert.equal(await tcpReachable(port), true, "the guard sees it");
        assert.equal(await isPortFree(port), false, "so leasing must not hand it out");
      } finally {
        server.close();
      }
    });
  }

  it("still calls an unused port free", async () => {
    const { isPortFree } = await import("../../src/core/net.js");
    const { server, port } = await listenOn("127.0.0.1");
    await new Promise<void>((resolve) => server.close(() => resolve()));

    assert.equal(await isPortFree(port), true);
  });
});
