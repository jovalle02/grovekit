import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  cleanup,
  git,
  makeRepo,
  pathExists,
  read,
  readJsonFile,
  runCli,
  setHydrate,
  tmpDir,
  write,
} from "../helpers.js";
import type { Manifest } from "../../src/types.js";

after(cleanup);

/** Machine-global state per test, so leases and the registry never leak between them. */
async function home(): Promise<string> {
  return tmpDir("home");
}

describe("grove new", () => {
  it("creates the branch, the worktree and its identity in one call", async () => {
    const repo = await makeRepo("new");
    const result = await runCli(["new", "feat/login", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = result.json<{
      ok: boolean;
      worktree: { slug: string; branch: string; root: string; createdBranch: boolean; base: string };
    }>();

    assert.equal(payload.ok, true);
    assert.equal(payload.worktree.slug, "feat-login");
    assert.equal(payload.worktree.branch, "feat/login");
    assert.equal(payload.worktree.createdBranch, true);
    assert.equal(payload.worktree.base, "main");
    assert.equal(await pathExists(path.join(payload.worktree.root, "worktree.toml")), true);
  });

  it("puts the worktree beside the repo, named after the slug", async () => {
    const repo = await makeRepo("new-path");
    const result = await runCli(["new", "fix/billing", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    const root = result.json<{ worktree: { root: string } }>().worktree.root;
    assert.equal(path.basename(root), `${path.basename(repo)}-fix-billing`);
    assert.equal(path.dirname(root), path.dirname(repo));
  });

  it("honours an explicit destination", async () => {
    const repo = await makeRepo("new-explicit");
    const dest = path.join(await tmpDir("dest"), "elsewhere");
    const result = await runCli(["new", "feat/x", "--no-up", "--path", dest, "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(path.resolve(result.json<{ worktree: { root: string } }>().worktree.root), path.resolve(dest));
  });

  it("checks out a branch that already exists instead of failing", async () => {
    const repo = await makeRepo("new-existing");
    await git(repo, ["branch", "hotfix"]);

    const result = await runCli(["new", "hotfix", "--no-up", "--json"], { cwd: repo, home: await home() });
    const payload = result.json<{ worktree: { createdBranch: boolean; base: string | null } }>();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(payload.worktree.createdBranch, false);
    assert.equal(payload.worktree.base, null);
  });

  it("refuses --from for an existing branch rather than silently ignoring it", async () => {
    const repo = await makeRepo("new-from-conflict");
    await git(repo, ["branch", "hotfix"]);

    const result = await runCli(["new", "hotfix", "--from", "main", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /already exists/);
  });

  it("branches from an explicit base ref", async () => {
    const repo = await makeRepo("new-from");
    await git(repo, ["checkout", "-q", "-b", "release"]);
    await write(path.join(repo, "RELEASE.md"), "1.0");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "release marker"]);
    await git(repo, ["checkout", "-q", "main"]);

    const result = await runCli(["new", "feat/on-release", "--from", "release", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    const root = result.json<{ worktree: { root: string } }>().worktree.root;
    assert.equal(await pathExists(path.join(root, "RELEASE.md")), true);
  });

  it("reports a base ref that does not exist", async () => {
    const repo = await makeRepo("new-badref");
    const result = await runCli(["new", "feat/x", "--from", "nope", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /does not exist/);
  });

  it("refuses to overwrite an existing directory", async () => {
    const repo = await makeRepo("new-occupied");
    const dest = path.join(await tmpDir("occupied"), "taken");
    await write(path.join(dest, "keep.txt"), "mine");

    const result = await runCli(["new", "feat/x", "--no-up", "--path", dest, "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 1);
    assert.equal(await read(path.join(dest, "keep.txt")), "mine");
  });

  it("hydrates gitignored files the new worktree would otherwise be missing", async () => {
    const repo = await makeRepo("new-hydrate");
    await setHydrate(repo, 'copy = [".env"]\nlink = ["node_modules"]');
    await git(repo, ["commit", "-qam", "hydrate config"]);

    // Both gitignored, so git will not bring them along — the whole problem.
    await write(path.join(repo, ".env"), "SECRET=1");
    await write(path.join(repo, "node_modules", "left-pad", "index.js"), "1");
    await write(path.join(repo, ".gitignore"), ".wt/\n.env\nnode_modules/\n");

    const result = await runCli(["new", "feat/hydrated", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    const payload = result.json<{
      worktree: { root: string };
      hydrate: { actions: { kind: string; status: string }[]; lockfilesMatch: boolean };
    }>();

    assert.equal(await read(path.join(payload.worktree.root, ".env")), "SECRET=1");
    assert.equal(
      await read(path.join(payload.worktree.root, "node_modules", "left-pad", "index.js")),
      "1",
    );
    assert.ok(payload.hydrate.actions.some((a) => a.kind === "link" && a.status === "applied"));
  });

  it("skips hydration when asked", async () => {
    const repo = await makeRepo("new-nohydrate");
    await setHydrate(repo, 'copy = [".env"]');
    await git(repo, ["commit", "-qam", "hydrate config"]);
    await write(path.join(repo, ".env"), "SECRET=1");

    const result = await runCli(["new", "feat/bare", "--no-up", "--no-hydrate", "--json"], {
      cwd: repo,
      home: await home(),
    });

    const payload = result.json<{ worktree: { root: string }; hydrate: null }>();
    assert.equal(payload.hydrate, null);
    assert.equal(await pathExists(path.join(payload.worktree.root, ".env")), false);
  });

  it("rolls the worktree back when setup fails, instead of leaving it half-built", async () => {
    // A half-created worktree holds the branch checked out, which blocks the
    // obvious fix of running the same command again.
    const repo = await makeRepo("new-rollback");
    await fs.rm(path.join(repo, "worktree.toml"));
    await git(repo, ["commit", "-qam", "remove config"]);

    const result = await runCli(["new", "feat/doomed", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /removed/);
    assert.equal(await pathExists(path.join(path.dirname(repo), `${path.basename(repo)}-feat-doomed`)), false);

    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    assert.doesNotMatch(list, /feat-doomed/);

    // The branch has to go too. Leaving it makes the obvious retry do something
    // different and worse: the branch now exists, so the second run checks it
    // out instead of creating it, inheriting the first run's base.
    assert.equal((await git(repo, ["branch", "--list", "feat/doomed"])).trim(), "");
  });
});

describe("worktree identity", () => {
  it("gives each worktree its own slug, and never inherits another's", async () => {
    // The failure this guards against was observed live: a committed state.json
    // made worktree B run `docker compose -p <A's slug>` and recreate A's
    // containers, while reporting A's name next to B's branch.
    const repo = await makeRepo("identity");
    const wtHome = await home();

    const a = await runCli(["new", "feat/a", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const b = await runCli(["new", "feat/b", "--no-up", "--json"], { cwd: repo, home: wtHome });

    const rootA = a.json<{ worktree: { root: string } }>().worktree.root;
    const rootB = b.json<{ worktree: { root: string } }>().worktree.root;

    const stateA = await readJsonFile<{ slug: string; root: string }>(path.join(rootA, ".wt", "state.json"));
    const stateB = await readJsonFile<{ slug: string; root: string }>(path.join(rootB, ".wt", "state.json"));

    assert.notEqual(stateA.slug, stateB.slug);
    assert.equal(path.resolve(stateA.root), path.resolve(rootA));
    assert.equal(path.resolve(stateB.root), path.resolve(rootB));
  });

  it("discards a state file that names a different directory", async () => {
    const repo = await makeRepo("identity-stolen");
    const wtHome = await home();

    const created = await runCli(["new", "feat/a", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;

    // Simulate the committed-state case: someone else's identity, verbatim.
    await write(
      path.join(root, ".wt", "state.json"),
      JSON.stringify({ slug: "someone-else", branch: "other", root: repo, createdAt: "2020-01-01" }),
    );

    await runCli(["status", "--json"], { cwd: root, home: wtHome });
    const state = await readJsonFile<{ slug: string }>(path.join(root, ".wt", "state.json"));
    assert.notEqual(state.slug, "someone-else");
    assert.equal(state.slug, "feat-a");
  });

  it("registers every worktree it touches, including ones created by hand", async () => {
    const repo = await makeRepo("identity-registry");
    const wtHome = await home();
    const dest = path.join(path.dirname(repo), "by-hand");

    await git(repo, ["worktree", "add", "-q", dest, "-b", "manual"]);
    await runCli(["status", "--json"], { cwd: dest, home: wtHome });

    const registry = await readJsonFile<{ worktrees: { slug: string; root: string }[] }>(
      path.join(wtHome, "registry.json"),
    );
    assert.ok(registry.worktrees.some((w) => w.slug === "manual"));
  });
});

describe("grove ls", () => {
  it("lists every worktree git knows about, with its stack status", async () => {
    const repo = await makeRepo("ls");
    const wtHome = await home();
    await runCli(["new", "feat/a", "--no-up", "--json"], { cwd: repo, home: wtHome });

    const result = await runCli(["ls", "--json"], { cwd: repo, home: wtHome });
    const payload = result.json<{ worktrees: { branch: string; status: string }[] }>();

    assert.equal(payload.worktrees.length, 2);
    assert.ok(payload.worktrees.some((w) => w.branch === "main"));
    assert.ok(payload.worktrees.some((w) => w.branch === "feat/a"));
  });
});

describe("grove rm", () => {
  it("removes the worktree, its state and its registry entry", async () => {
    const repo = await makeRepo("rm");
    const wtHome = await home();

    const created = await runCli(["new", "feat/gone", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;

    const result = await runCli(["rm", "feat-gone", "--json"], { cwd: repo, home: wtHome });
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await pathExists(root), false);
    const registry = await readJsonFile<{ worktrees: unknown[] }>(path.join(wtHome, "registry.json"));
    assert.equal(registry.worktrees.some((w) => (w as { slug: string }).slug === "feat-gone"), false);
  });

  it("accepts a slug, a branch or a path", async () => {
    const repo = await makeRepo("rm-selector");
    const wtHome = await home();

    for (const [branch, selector] of [
      ["feat/one", "feat-one"],
      ["feat/two", "feat/two"],
    ] as const) {
      await runCli(["new", branch, "--no-up", "--json"], { cwd: repo, home: wtHome });
      const result = await runCli(["rm", selector, "--json"], { cwd: repo, home: wtHome });
      assert.equal(result.code, 0, `${selector}: ${result.stderr}`);
    }
  });

  it("refuses to remove the main worktree", async () => {
    const repo = await makeRepo("rm-main");
    const result = await runCli(["rm", "main", "--json"], { cwd: repo, home: await home() });

    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /main worktree/);
    assert.equal(await pathExists(path.join(repo, "worktree.toml")), true);
  });

  it("removes a worktree whose name is a prefix of the one you are standing in", async () => {
    // `app-feat` and `app-feature` are siblings, not parent and child — and
    // branches named that way are the normal case for this tool.
    const repo = await makeRepo("rm-prefix");
    const wtHome = await home();
    await runCli(["new", "feat", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const longer = await runCli(["new", "feature", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const inside = longer.json<{ worktree: { root: string } }>().worktree.root;

    const result = await runCli(["rm", "feat", "--json"], { cwd: inside, home: wtHome });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(await pathExists(inside), true, "the worktree we were standing in survived");
  });

  it("refuses to remove the worktree you are standing in", async () => {
    const repo = await makeRepo("rm-cwd");
    const wtHome = await home();
    const created = await runCli(["new", "feat/here", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;

    const result = await runCli(["rm", "feat-here", "--json"], { cwd: root, home: wtHome });
    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /currently inside/);
    assert.equal(await pathExists(root), true);
  });

  it("refuses to discard uncommitted work without --force", async () => {
    const repo = await makeRepo("rm-dirty");
    const wtHome = await home();
    const created = await runCli(["new", "feat/wip", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;
    await write(path.join(root, "notes.md"), "unsaved work");

    const refused = await runCli(["rm", "feat-wip", "--json"], { cwd: repo, home: wtHome });
    assert.equal(refused.code, 1);
    assert.match(refused.json<{ error: string }>().error, /uncommitted changes/);
    assert.equal(await pathExists(root), true);

    const forced = await runCli(["rm", "feat-wip", "--force", "--json"], { cwd: repo, home: wtHome });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(await pathExists(root), false);
  });

  it("deletes the branch only when asked", async () => {
    const repo = await makeRepo("rm-branch");
    const wtHome = await home();

    await runCli(["new", "feat/keep", "--no-up", "--json"], { cwd: repo, home: wtHome });
    await runCli(["rm", "feat-keep", "--json"], { cwd: repo, home: wtHome });
    assert.match(await git(repo, ["branch", "--list", "feat/keep"]), /feat\/keep/);

    await runCli(["new", "feat/drop", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const result = await runCli(["rm", "feat-drop", "--delete-branch", "--force", "--json"], {
      cwd: repo,
      home: wtHome,
    });
    assert.equal(result.json<{ removed: { branchDeleted: boolean } }>().removed.branchDeleted, true);
    assert.equal((await git(repo, ["branch", "--list", "feat/drop"])).trim(), "");
  });

  it("releases the worktree's port leases", async () => {
    const repo = await makeRepo("rm-leases");
    const wtHome = await home();

    const created = await runCli(["new", "feat/leased", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;
    // `status` leases host ports for every service that declares one.
    await runCli(["status", "--json"], { cwd: root, home: wtHome });

    const before = await readJsonFile<Record<string, number>>(path.join(wtHome, "leases.json"));
    assert.ok(Object.keys(before).some((k) => k.startsWith("feat-leased/")));

    await runCli(["rm", "feat-leased", "--json"], { cwd: repo, home: wtHome });
    const after = await readJsonFile<Record<string, number>>(path.join(wtHome, "leases.json"));
    assert.equal(Object.keys(after).some((k) => k.startsWith("feat-leased/")), false);
  });

  it("reports a selector that matches nothing", async () => {
    const repo = await makeRepo("rm-missing");
    const result = await runCli(["rm", "ghost", "--json"], { cwd: repo, home: await home() });
    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /No worktree matches/);
  });
});

describe("grove gc", () => {
  it("reclaims leases whose worktree is gone", async () => {
    const repo = await makeRepo("gc-leases");
    const wtHome = await home();

    const created = await runCli(["new", "feat/orphan", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;
    await runCli(["status", "--json"], { cwd: root, home: wtHome });

    // Deleted the way people actually delete things, which is exactly how
    // orphans are created.
    await fs.rm(root, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);

    const dry = await runCli(["gc", "--dry-run", "--json"], { cwd: repo, home: wtHome });
    const planned = dry.json<{ actions: { kind: string; target: string }[] }>().actions;
    assert.ok(planned.some((a) => a.kind === "leases" && a.target.startsWith("feat-orphan/")));

    // A dry run must change nothing.
    const stillThere = await readJsonFile<Record<string, number>>(path.join(wtHome, "leases.json"));
    assert.ok(Object.keys(stillThere).some((k) => k.startsWith("feat-orphan/")));

    await runCli(["gc", "--json"], { cwd: repo, home: wtHome });
    const after = await readJsonFile<Record<string, number>>(path.join(wtHome, "leases.json"));
    assert.equal(Object.keys(after).some((k) => k.startsWith("feat-orphan/")), false);
  });

  it("never touches a lease belonging to a live worktree", async () => {
    const repo = await makeRepo("gc-safety");
    const wtHome = await home();

    const created = await runCli(["new", "feat/alive", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;
    await runCli(["status", "--json"], { cwd: root, home: wtHome });

    await runCli(["gc", "--json"], { cwd: repo, home: wtHome });

    const after = await readJsonFile<Record<string, number>>(path.join(wtHome, "leases.json"));
    assert.ok(Object.keys(after).some((k) => k.startsWith("feat-alive/")));
  });

  it("drops registry entries whose directory has vanished", async () => {
    const repo = await makeRepo("gc-registry");
    const wtHome = await home();

    const created = await runCli(["new", "feat/vanished", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;
    await fs.rm(root, { recursive: true, force: true });

    await runCli(["gc", "--json"], { cwd: repo, home: wtHome });

    const registry = await readJsonFile<{ worktrees: { slug: string }[] }>(
      path.join(wtHome, "registry.json"),
    );
    assert.equal(registry.worktrees.some((w) => w.slug === "feat-vanished"), false);
  });

  it("says so when there is nothing to collect", async () => {
    const repo = await makeRepo("gc-clean");
    const result = await runCli(["gc", "--json"], { cwd: repo, home: await home() });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json<{ actions: unknown[] }>().actions, []);
  });
});

describe("grove hydrate", () => {
  it("re-copies files into an existing worktree", async () => {
    const repo = await makeRepo("hydrate-cmd");
    await setHydrate(repo, 'copy = [".env"]');
    await git(repo, ["commit", "-qam", "hydrate config"]);

    const wtHome = await home();
    const created = await runCli(["new", "feat/later", "--no-up", "--no-hydrate", "--json"], {
      cwd: repo,
      home: wtHome,
    });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;

    // The file appears in the main worktree only after the branch was created.
    await write(path.join(repo, ".env"), "SECRET=2");

    const result = await runCli(["hydrate", "--json"], { cwd: root, home: wtHome });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await read(path.join(root, ".env")), "SECRET=2");
  });

  it("refuses to hydrate the main worktree from itself", async () => {
    const repo = await makeRepo("hydrate-main");
    await setHydrate(repo, 'copy = [".env"]');

    const result = await runCli(["hydrate", "--json"], { cwd: repo, home: await home() });
    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /main worktree/);
  });
});

describe("grove install", () => {
  it("writes the skill, the slash command, the hooks and the gitignore entry", async () => {
    const repo = await makeRepo("install");
    const result = await runCli(["install", "--json"], { cwd: repo, home: await home() });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(repo, ".claude", "skills", "git-grove", "SKILL.md")), true);
    assert.equal(await pathExists(path.join(repo, ".claude", "commands", "setup-git-grove.md")), true);

    const settings = await readJsonFile<{
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    }>(path.join(repo, ".claude", "settings.json"));

    assert.match(settings.hooks.SessionStart?.[0]?.hooks[0]?.command ?? "", /hook session-start$/);
    assert.match(settings.hooks.SessionEnd?.[0]?.hooks[0]?.command ?? "", /hook session-end$/);

    // A hook that shells out to a binary not on PATH fails silently — the
    // session starts and nothing anywhere says why. So the command written must
    // be resolved at install time, and verified to be *this* package: `ewt` when
    // it is installed globally, `grove` where that name is free, the npx fallback
    // when neither resolves. Never a name that belongs to another program.
    assert.match(
      settings.hooks.SessionStart?.[0]?.hooks[0]?.command ?? "",
      /^(ewt|grove|npx --no-install git-grove) hook session-start$/,
    );

    assert.match(await read(path.join(repo, ".gitignore")), /^\.wt\/$/m);
  });

  it("is idempotent and preserves hooks the user already had", async () => {
    const repo = await makeRepo("install-idempotent");
    const wtHome = await home();
    await write(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2),
    );

    await runCli(["install", "--json"], { cwd: repo, home: wtHome });
    await runCli(["install", "--json"], { cwd: repo, home: wtHome });

    const settings = await readJsonFile<{
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    }>(path.join(repo, ".claude", "settings.json"));

    const commands = settings.hooks.SessionStart?.flatMap((e) => e.hooks.map((h) => h.command)) ?? [];
    assert.ok(commands.includes("echo mine"), "user's own hook was dropped");
    assert.equal(commands.filter((cmd) => /session-start/.test(cmd)).length, 1, "hook was added twice");
  });

  it("does not overwrite a customised skill without --force", async () => {
    const repo = await makeRepo("install-custom");
    const wtHome = await home();
    const skill = path.join(repo, ".claude", "skills", "git-grove", "SKILL.md");
    await write(skill, "my own words");

    const first = await runCli(["install", "--json"], { cwd: repo, home: wtHome });
    assert.equal(await read(skill), "my own words");
    assert.equal(first.code, 1, "should report that it skipped something");

    await runCli(["install", "--force", "--json"], { cwd: repo, home: wtHome });
    assert.notEqual(await read(skill), "my own words");
  });
});

describe("grove hook", () => {
  it("reports the worktree and what to do next, for injection into a session", async () => {
    const repo = await makeRepo("hook");
    const wtHome = await home();
    const created = await runCli(["new", "feat/session", "--no-up", "--json"], { cwd: repo, home: wtHome });
    const root = created.json<{ worktree: { root: string } }>().worktree.root;

    const result = await runCli(["hook", "session-start"], { cwd: root, home: wtHome });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /feat-session/);
    assert.match(result.stdout, /grove up/);
  });

  it("stays silent and successful outside a configured repo", async () => {
    // A hook must never break the session it is attached to.
    const dir = await tmpDir("hook-bare");
    const result = await runCli(["hook", "session-start"], { cwd: dir, home: await home() });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it("does nothing on session end unless configured to", async () => {
    const repo = await makeRepo("hook-end");
    const result = await runCli(["hook", "session-end"], { cwd: repo, home: await home() });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "");
  });
});

describe("grove adapt", () => {
  it("reads the repo's compose file as data and classifies every service", async () => {
    const repo = await makeRepo("adapt");
    const result = await runCli(["adapt", "evidence", "--json"], { cwd: repo, home: await home() });

    assert.equal(result.code, 0, result.stderr);
    const evidence = result.json<{
      services: { name: string; ports: { published: number | null; target: number }[]; guess: { kind: string } }[];
    }>();

    const db = evidence.services.find((s) => s.name === "db");
    assert.equal(db?.guess.kind, "tcp");
    assert.deepEqual(
      evidence.services.map((s) => s.name),
      ["api", "db", "web"],
      "services are sorted, so the output is diffable",
    );
  });

  it("turns evidence into decisions and decisions into files", async () => {
    const repo = await makeRepo("adapt-render");
    const wtHome = await home();
    // The fixture already ships an overlay; render into a scratch dir instead.
    await runCli(["adapt", "evidence", "--json"], { cwd: repo, home: wtHome });

    const decided = await runCli(["adapt", "decide", "--heuristic", "--json"], { cwd: repo, home: wtHome });
    assert.equal(decided.code, 0, decided.stderr);

    const rendered = await runCli(["adapt", "render", "--out", "generated", "--json"], {
      cwd: repo,
      home: wtHome,
    });
    assert.equal(rendered.code, 0, rendered.stderr);

    const overlay = await read(path.join(repo, "generated", "docker-compose.worktree.yml"));
    assert.match(overlay, /traefik\.http\.routers\.\$\{WT_NAME\}-web\.rule=Host\(`web\./);
    assert.match(overlay, /ports: !override/);
    assert.match(await read(path.join(repo, "generated", "worktree.toml")), /\[\[services\]\]/);
  });

  it("refuses to overwrite existing decisions without --force", async () => {
    const repo = await makeRepo("adapt-force");
    const wtHome = await home();
    await runCli(["adapt", "evidence", "--json"], { cwd: repo, home: wtHome });
    await runCli(["adapt", "decide", "--heuristic", "--json"], { cwd: repo, home: wtHome });

    const second = await runCli(["adapt", "decide", "--heuristic", "--json"], { cwd: repo, home: wtHome });
    assert.equal(second.code, 1);
    assert.match(second.json<{ error: string }>().error, /already exists/);
  });

  it("validates the overlay the fixture ships", async () => {
    const repo = await makeRepo("adapt-validate");
    const result = await runCli(["adapt", "validate", "--json"], { cwd: repo, home: await home() });
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(result.json<{ problems: unknown[] }>().problems, []);
  });

  it("catches a service with no internal alias", async () => {
    // Works with one worktree, goes ambiguous with two — the worst failure mode
    // there is, because everything you test first passes.
    const repo = await makeRepo("adapt-validate-bad");
    const overlay = path.join(repo, "docker-compose.worktree.yml");
    const text = await read(overlay);
    await write(overlay, text.replace(/\n\s+aliases:\n\s+- api\.internal/, ""));

    const result = await runCli(["adapt", "validate", "--json"], { cwd: repo, home: await home() });
    assert.equal(result.code, 1);
    assert.ok(
      result.json<{ problems: { detail: string }[] }>().problems.some((p) => /api\.internal/.test(p.detail)),
    );
  });
});

describe("cli", () => {
  it("reports an unknown command as JSON when asked", async () => {
    const dir = await tmpDir("cli");
    const result = await runCli(["frobnicate", "--json"], { cwd: dir, home: await home() });
    assert.equal(result.code, 1);
    assert.match(result.json<{ error: string }>().error, /unknown command/);
  });

  it("prints help without needing a repo", async () => {
    const dir = await tmpDir("cli-help");
    const result = await runCli(["--help"], { cwd: dir, home: await home() });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /every git worktree gets its own stack/);
  });
});

describe("grove new default base", () => {
  it("branches from where you are standing, like git switch -c", async () => {
    // Found on a real repo: the config enabling this tool lived on a feature
    // branch, `grove new` branched from main instead, and the new worktree had no
    // worktree.toml at all.
    const repo = await makeRepo("new-base");
    await git(repo, ["checkout", "-q", "-b", "enablement"]);
    await write(path.join(repo, "MARKER.txt"), "only on enablement");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "marker"]);

    const result = await runCli(["new", "feat/from-here", "--no-up", "--json"], {
      cwd: repo,
      home: await home(),
    });

    const payload = result.json<{ worktree: { root: string; base: string } }>();
    assert.equal(payload.worktree.base, "enablement");
    assert.equal(await pathExists(path.join(payload.worktree.root, "MARKER.txt")), true);
  });
});

describe("grove adapt on a repo with no containers", () => {
  it("reports the shape instead of failing, and says what to do", async () => {
    // The setup command starts here, and an agent following it needs to be told
    // which of the two paths it is on. Throwing "no compose file" tells it
    // nothing about the other one.
    const repo = await makeRepo("adapt-hostonly");
    await fs.rm(path.join(repo, "docker-compose.yml"));
    await fs.rm(path.join(repo, "docker-compose.worktree.yml"));

    const result = await runCli(["adapt", "evidence", "--json"], {
      cwd: repo,
      home: await home(),
    });

    assert.equal(result.code, 0, "not an error — it is the other supported shape");
    const evidence = result.json<{ containerised: boolean; services: unknown[]; warnings: string[] }>();
    assert.equal(evidence.containerised, false);
    assert.deepEqual(evidence.services, []);
    assert.ok(
      evidence.warnings.some((w) => /runtime = "host"/.test(w)),
      "it should name the path to take instead",
    );
  });
});
