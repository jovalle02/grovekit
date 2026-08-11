import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envKey, slugify, uniqueSlug } from "../../src/core/naming.js";
import { quoteForShell } from "../../src/commands/run.js";

describe("slugify", () => {
  it("produces something usable as a DNS label, a Compose project and a database name", () => {
    assert.equal(slugify("feature/login-rework"), "feature-login-rework");
    assert.equal(slugify("fix/BILLING"), "fix-billing");
    assert.equal(slugify("feat/a_b.c"), "feat-a-b-c");
    assert.equal(slugify("release/2024.10"), "release-2024-10");
  });

  it("never starts or ends with a dash — a DNS label may not", () => {
    assert.equal(slugify("-leading"), "leading");
    assert.equal(slugify("trailing---"), "trailing");
    assert.equal(slugify("///"), "wt");
    assert.equal(slugify(""), "wt");
    for (const branch of ["--x--", "1.2.3", "_", "feat//x"]) {
      assert.match(slugify(branch), /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, branch);
    }
  });

  it("stays well under the 63-character DNS label limit", () => {
    const slug = slugify("feature/" + "x".repeat(200));
    assert.ok(slug.length <= 40, slug);
    assert.doesNotMatch(slug, /-$/);
  });

  it("is a pure function of the branch name", () => {
    assert.equal(slugify("feat/x"), slugify("feat/x"));
  });
});

describe("uniqueSlug", () => {
  it("returns the plain slug when nothing has taken it", () => {
    assert.equal(uniqueSlug("feat/x", new Set()), "feat-x");
  });

  it("disambiguates branches that slugify identically", () => {
    // The only way to collide: git already forbids two worktrees on one branch.
    const taken = new Set(["feat-a-b"]);
    const a = uniqueSlug("feat/a_b", taken);
    assert.notEqual(a, "feat-a-b");
    assert.match(a, /^feat-a-b-[0-9a-f]{4}$/);
  });

  it("is deterministic, so a worktree lands on the same slug every time", () => {
    const taken = new Set(["feat-a-b"]);
    assert.equal(uniqueSlug("feat/a_b", taken), uniqueSlug("feat/a_b", taken));
  });

  it("keeps the disambiguated form within the length budget", () => {
    const base = slugify("x".repeat(100));
    const slug = uniqueSlug("x".repeat(100), new Set([base]));
    assert.ok(slug.length <= 40, slug);
  });
});

describe("envKey", () => {
  it("maps a service name onto an environment variable suffix", () => {
    assert.equal(envKey("db"), "DB");
    assert.equal(envKey("api-gateway"), "API_GATEWAY");
    assert.equal(envKey("web.next"), "WEB_NEXT");
  });
});

describe("quoteForShell", () => {
  // `wt run` must go through a shell (npm/pnpm/yarn are .cmd shims on Windows
  // that spawn cannot exec), which means handing it one string. Re-quoting each
  // argument is what stops `node -e 'a b'` arriving as three words.
  it("passes simple tokens through untouched", () => {
    assert.equal(quoteForShell("npm"), "npm");
    assert.equal(quoteForShell("test:e2e"), "test:e2e");
    assert.equal(quoteForShell("--json"), "--json");
  });

  it("quotes anything containing whitespace", () => {
    const quoted = quoteForShell("console.log(1)");
    assert.notEqual(quoted, "console.log(1)");
    assert.ok(quoted.startsWith(process.platform === "win32" ? '"' : "'"));
  });

  it("preserves an empty argument as an empty argument", () => {
    assert.equal(quoteForShell(""), process.platform === "win32" ? '""' : "''");
  });

  it("escapes the platform's own quote character", () => {
    if (process.platform === "win32") {
      assert.equal(quoteForShell('say "hi"'), '"say ""hi"""');
    } else {
      assert.equal(quoteForShell("it's"), `'it'\\''s'`);
    }
  });
});
