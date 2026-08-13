import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { REPO_ROOT, cleanup, makeRepo, pathExists, read, runCli } from "../helpers.js";

after(cleanup);

/** Every file the package ships under `templates/`, as repo-relative paths. */
async function templateFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await templateFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Relative markdown links in `content`, ignoring URLs and bare anchors. */
function localLinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = (m[1] ?? "").split("#")[0]?.trim() ?? "";
    if (target && !/^[a-z]+:/i.test(target)) out.push(target);
  }
  return out;
}

/** `templates/skills/<x>` -> `.claude/skills/<x>`, `templates/commands` -> `.claude/commands`. */
function installedPath(root: string, templateRel: string): string {
  return path.join(root, ".claude", templateRel);
}

describe("install", () => {
  it("writes every shipped template, not just the skill entry point", async () => {
    const root = await makeRepo("install");
    const result = await runCli(["install", "--json"], { cwd: root });
    assert.equal(result.code, 0, result.stdout + result.stderr);

    const shipped = await templateFiles(path.join(REPO_ROOT, "templates"));
    // The skill ships reference siblings next to SKILL.md. A copy that only took
    // the entry point would leave every pointer in it dangling.
    assert.ok(
      shipped.some((f) => f.startsWith("skills/grove/") && !f.endsWith("SKILL.md")),
      "expected the grove skill to ship reference files beside SKILL.md",
    );

    for (const rel of shipped) {
      assert.ok(await pathExists(installedPath(root, rel)), `${rel} was not installed`);
    }
  });

  it("leaves no dangling pointer between the files it wrote", async () => {
    const root = await makeRepo("install-links");
    await runCli(["install", "--json"], { cwd: root });

    const shipped = await templateFiles(path.join(REPO_ROOT, "templates"));
    let checked = 0;

    for (const rel of shipped.filter((f) => f.endsWith(".md"))) {
      const file = installedPath(root, rel);
      for (const link of localLinks(await read(file))) {
        const target = path.resolve(path.dirname(file), link);
        assert.ok(await pathExists(target), `${rel} points at ${link}, which does not exist`);
        checked++;
      }
    }

    assert.ok(checked > 0, "expected the templates to cross-reference each other");
  });

  it("reports a partial install rather than overwriting what is already there", async () => {
    const root = await makeRepo("install-twice");
    assert.equal((await runCli(["install", "--json"], { cwd: root })).code, 0);

    const skill = path.join(root, ".claude", "skills", "grove", "SKILL.md");
    await fs.writeFile(skill, "edited by hand\n", "utf8");

    // Non-zero so a caller learns the tree is no longer what this version ships -
    // the only drift signal there is, since nothing stamps a version into the file.
    const second = await runCli(["install", "--json"], { cwd: root });
    assert.equal(second.code, 1);
    assert.equal(await read(skill), "edited by hand\n");

    const forced = await runCli(["install", "--force", "--json"], { cwd: root });
    assert.equal(forced.code, 0);
    assert.notEqual(await read(skill), "edited by hand\n");
  });
});
