import assert from "node:assert/strict";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { parseWorktreeList } from "../../src/core/git.js";
import { leasePort, readLeasesFor, releaseLeases } from "../../src/core/ports.js";
import { findBySlug, readRegistry, register, unregister } from "../../src/core/registry.js";
import { cleanup, tmpDir } from "../helpers.js";

after(cleanup);

/**
 * Machine-global state, isolated per test.
 *
 * Declared inside each suite on purpose: a root-level `beforeEach` runs before
 * each *suite*, not before each test in it, which would leave these sharing one
 * directory and passing for the wrong reason.
 */
const isolateHome = () =>
  beforeEach(async () => {
    process.env.EASY_WORKTREE_HOME = await tmpDir("home");
  });

describe("parseWorktreeList", () => {
  it("reads the porcelain format including detached and bare entries", () => {
    const list = parseWorktreeList(
      [
        "worktree /repo/app",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo/app-feature",
        "HEAD def456",
        "branch refs/heads/feat/login",
        "",
        "worktree /repo/app-detached",
        "HEAD 999999",
        "detached",
        "",
      ].join("\n"),
    );

    assert.equal(list.length, 3);
    assert.equal(list[0]?.branch, "main");
    assert.equal(list[1]?.branch, "feat/login");
    assert.equal(list[2]?.detached, true);
    assert.equal(list[2]?.branch, "(detached)");
  });

  it("handles a final entry with no trailing blank line", () => {
    const list = parseWorktreeList("worktree /repo/app\nHEAD abc\nbranch refs/heads/main");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.branch, "main");
  });

  it("returns nothing for empty input rather than a phantom entry", () => {
    assert.deepEqual(parseWorktreeList(""), []);
  });
});

describe("port leases", () => {
  isolateHome();

  it("hands out a port and then returns the same one forever", async () => {
    // Re-probing an existing lease would report it busy - our own container is
    // holding it - and renumber the database on every `grove up`.
    const first = await leasePort("demo/db");
    const second = await leasePort("demo/db");
    assert.equal(first, second);
    assert.ok(first >= 20_000 && first < 24_000, `${first} outside the lease range`);
  });

  it("never hands the same port to two keys", async () => {
    const ports = new Set<number>();
    for (const key of ["a/db", "b/db", "c/db", "d/db"]) ports.add(await leasePort(key));
    assert.equal(ports.size, 4);
  });

  it("is deterministic: the same key seeks the same port on a clean machine", async () => {
    const first = await leasePort("stable/db");
    process.env.EASY_WORKTREE_HOME = await tmpDir("home");
    assert.equal(await leasePort("stable/db"), first);
  });

  it("scopes reads and releases to one worktree", async () => {
    await leasePort("keep/db");
    await leasePort("drop/db");
    await leasePort("drop/cache");

    assert.deepEqual(Object.keys(await readLeasesFor("drop")).sort(), ["cache", "db"]);

    const released = await releaseLeases("drop");
    assert.equal(released.length, 2);
    assert.deepEqual(await readLeasesFor("drop"), {});
    assert.equal(Object.keys(await readLeasesFor("keep")).length, 1);
  });

  it("does not match a slug that merely shares a prefix", async () => {
    await leasePort("feat/db");
    await leasePort("feat-two/db");
    await releaseLeases("feat");
    assert.equal(Object.keys(await readLeasesFor("feat-two")).length, 1);
  });
});

describe("registry", () => {
  isolateHome();

  const entry = { slug: "fix-billing", root: "/repo/app-fix", branch: "fix/billing", repo: "/repo/app" };

  it("records a worktree and finds it again by slug", async () => {
    await register(entry);
    const found = await findBySlug("fix-billing");
    assert.equal(found?.root, path.resolve(entry.root));
    assert.equal(found?.branch, "fix/billing");
  });

  it("upserts by root rather than accumulating duplicates", async () => {
    await register(entry);
    await register({ ...entry, branch: "fix/billing-v2", slug: "fix-billing-v2" });

    const reg = await readRegistry();
    assert.equal(reg.worktrees.length, 1);
    assert.equal(reg.worktrees[0]?.slug, "fix-billing-v2");
  });

  it("keeps the original creation time across updates", async () => {
    const created = await register(entry);
    const updated = await register({ ...entry, branch: "other" });
    assert.equal(updated.createdAt, created.createdAt);
  });

  it("removes an entry by root and reports whether it did", async () => {
    await register(entry);
    assert.equal(await unregister(entry.root), true);
    assert.equal(await unregister(entry.root), false);
    assert.equal((await readRegistry()).worktrees.length, 0);
  });

  it("reads as empty when the file has never been written", async () => {
    const reg = await readRegistry();
    assert.deepEqual(reg.worktrees, []);
  });
});
