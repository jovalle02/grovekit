import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { expandGlob } from "../../src/core/glob.js";
import { compareLockfiles, hydrate } from "../../src/core/hydrate.js";
import { cleanup, pathExists, read, tmpDir, write } from "../helpers.js";

after(cleanup);

async function pair(): Promise<{ source: string; dest: string }> {
  const dir = await tmpDir("hydrate");
  const source = path.join(dir, "source");
  const dest = path.join(dir, "dest");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(dest, { recursive: true });
  return { source, dest };
}

describe("expandGlob", () => {
  it("matches literal paths and wildcards at one level", async () => {
    const dir = await tmpDir("glob");
    await write(path.join(dir, ".env"), "x");
    await write(path.join(dir, "apps", "web", ".env.local"), "x");
    await write(path.join(dir, "apps", "api", ".env.local"), "x");
    await write(path.join(dir, "apps", "api", "other.txt"), "x");

    assert.deepEqual(await expandGlob(dir, ".env"), [".env"]);
    assert.deepEqual(await expandGlob(dir, "apps/*/.env.local"), [
      "apps/api/.env.local",
      "apps/web/.env.local",
    ]);
  });

  it("returns nothing for a pattern that matches nothing", async () => {
    const dir = await tmpDir("glob-empty");
    assert.deepEqual(await expandGlob(dir, "missing/*.json"), []);
  });

  it("sorts results so a hydration plan is reproducible", async () => {
    const dir = await tmpDir("glob-sort");
    for (const name of ["z", "a", "m"]) await write(path.join(dir, "pkg", name, ".env"), "x");
    assert.deepEqual(await expandGlob(dir, "pkg/*/.env"), [
      "pkg/a/.env",
      "pkg/m/.env",
      "pkg/z/.env",
    ]);
  });

  it("matches directories, not just files", async () => {
    const dir = await tmpDir("glob-dir");
    await write(path.join(dir, "node_modules", "left-pad", "index.js"), "x");
    assert.deepEqual(await expandGlob(dir, "node_modules"), ["node_modules"]);
  });
});

describe("compareLockfiles", () => {
  it("reports a match when the lockfile is byte-identical", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, "pnpm-lock.yaml"), "lock: 1");
    await write(path.join(dest, "pnpm-lock.yaml"), "lock: 1");

    const result = await compareLockfiles(source, dest, []);
    assert.deepEqual(result.lockfiles, ["pnpm-lock.yaml"]);
    assert.equal(result.match, true);
  });

  it("reports a mismatch when the branch changed its dependencies", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, "pnpm-lock.yaml"), "lock: 1");
    await write(path.join(dest, "pnpm-lock.yaml"), "lock: 2");

    assert.equal((await compareLockfiles(source, dest, [])).match, false);
  });

  it("treats nothing-to-compare as a match", async () => {
    const { source, dest } = await pair();
    const result = await compareLockfiles(source, dest, []);
    assert.deepEqual(result.lockfiles, []);
    assert.equal(result.match, true);
  });
});

describe("hydrate", () => {
  it("copies gitignored files a fresh worktree does not get from git", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, ".env"), "SECRET=1");
    await write(path.join(source, "apps", "web", ".env.local"), "PUBLIC=2");

    const result = await hydrate(source, dest, {
      copy: [".env", "apps/*/.env.local"],
      link: [],
      run: [],
      lockfiles: [],
    });

    assert.equal(result.ok, true);
    assert.equal(await read(path.join(dest, ".env")), "SECRET=1");
    assert.equal(await read(path.join(dest, "apps", "web", ".env.local")), "PUBLIC=2");
  });

  it("never clobbers a file the destination already has", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, ".env"), "FROM_SOURCE");
    await write(path.join(dest, ".env"), "EDITED_HERE");

    const result = await hydrate(source, dest, { copy: [".env"], link: [], run: [], lockfiles: [] });

    assert.equal(await read(path.join(dest, ".env")), "EDITED_HERE");
    assert.equal(result.actions[0]?.status, "skipped");
    assert.match(result.actions[0]?.reason ?? "", /already present/);
  });

  it("overwrites when explicitly forced", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, ".env"), "FROM_SOURCE");
    await write(path.join(dest, ".env"), "EDITED_HERE");

    await hydrate(source, dest, { copy: [".env"], link: [], run: [], lockfiles: [] }, { force: true });
    assert.equal(await read(path.join(dest, ".env")), "FROM_SOURCE");
  });

  it("links large identical directories instead of copying them", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, "package-lock.json"), "{}");
    await write(path.join(dest, "package-lock.json"), "{}");
    await write(path.join(source, "node_modules", "left-pad", "index.js"), "module.exports = 1");

    const result = await hydrate(source, dest, {
      copy: [],
      link: ["node_modules"],
      run: ["exit 1"],
      lockfiles: [],
    });

    assert.equal(result.lockfilesMatch, true);
    assert.equal(result.actions.find((a) => a.kind === "link")?.status, "applied");
    // The link is real: the file is readable through it.
    assert.equal(
      await read(path.join(dest, "node_modules", "left-pad", "index.js")),
      "module.exports = 1",
    );
    const stat = await fs.lstat(path.join(dest, "node_modules"));
    assert.equal(stat.isSymbolicLink(), true);
  });

  it("does not run the install command when it linked the dependencies", async () => {
    // Running an install through a link writes into the *source* worktree, which
    // corrupts a tree the user is actively working in.
    const { source, dest } = await pair();
    await write(path.join(source, "package-lock.json"), "{}");
    await write(path.join(dest, "package-lock.json"), "{}");
    await write(path.join(source, "node_modules", "x.js"), "1");

    const result = await hydrate(source, dest, {
      copy: [],
      link: ["node_modules"],
      run: ["node -e \"require('fs').writeFileSync('ran.txt','1')\""],
      lockfiles: [],
    });

    assert.equal(result.actions.find((a) => a.kind === "run")?.status, "skipped");
    assert.equal(await pathExists(path.join(dest, "ran.txt")), false);
  });

  it("installs instead of linking when the branch changed its lockfile", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, "package-lock.json"), '{"v":1}');
    await write(path.join(dest, "package-lock.json"), '{"v":2}');
    await write(path.join(source, "node_modules", "x.js"), "1");

    const result = await hydrate(source, dest, {
      copy: [],
      link: ["node_modules"],
      run: ["node -e \"require('fs').writeFileSync('ran.txt','1')\""],
      lockfiles: [],
    });

    assert.equal(result.lockfilesMatch, false);
    assert.equal(result.actions.find((a) => a.kind === "link")?.status, "skipped");
    assert.equal(await pathExists(path.join(dest, "node_modules")), false);
    assert.equal(result.actions.find((a) => a.kind === "run")?.status, "applied");
    assert.equal(await pathExists(path.join(dest, "ran.txt")), true);
  });

  it("reports a failing install command instead of claiming success", async () => {
    const { source, dest } = await pair();
    const result = await hydrate(source, dest, {
      copy: [],
      link: [],
      run: ["node -e \"process.exit(3)\""],
      lockfiles: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.actions[0]?.status, "failed");
  });

  it("changes nothing in a dry run", async () => {
    const { source, dest } = await pair();
    await write(path.join(source, ".env"), "SECRET=1");

    const result = await hydrate(source, dest, { copy: [".env"], link: [], run: [], lockfiles: [] }, { dryRun: true });

    assert.equal(await pathExists(path.join(dest, ".env")), false);
    assert.equal(result.actions[0]?.status, "skipped");
    assert.equal(result.actions[0]?.reason, "dry-run");
  });
});
