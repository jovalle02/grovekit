import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN_NAMES, PACKAGE_NAME, resolveBin } from "../core/bin.js";
import { gitRoot } from "../core/context.js";
import { exists } from "../core/glob.js";
import { readJson } from "../core/lock.js";
import { c, printJson } from "../core/output.js";

export interface InstallOptions {
  json: boolean;
  /** Overwrite files that already exist instead of leaving them alone. */
  force: boolean;
  /** Write hooks to the user's `~/.claude/settings.json` instead of the repo's. */
  global: boolean;
}

interface Written {
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

const AGENTS_MARKER = "<!-- git-grove -->";

/** `dist/commands/install.js` and `src/commands/install.ts` are both two deep. */
function templatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

/**
 * Wire the tool into an agent's environment. Mechanical on purpose — no model
 * involved and no judgment applied.
 *
 * What it deliberately does NOT do is write the compose overlay. Migrating a
 * repo needs decisions about which services face a browser and which are
 * internal, and a wrong guess there produces a stack that boots and then serves
 * 404s. That is `grove adapt`.
 */
export async function install(opts: InstallOptions): Promise<void> {
  const root = await gitRoot();
  const written: Written[] = [];

  // A hook that shells out to a binary not on PATH fails silently — the session
  // starts, nothing is injected, and nothing anywhere says why. Resolve it now,
  // at write time, when we can actually check.
  //
  // Checking the *name* is not enough, and this bit a real install: `which("wt")`
  // returned true because Windows ships `wt.exe` (Windows Terminal) as an app
  // execution alias on every user's PATH. The hook written on the strength of
  // that would have opened a terminal window at the start of every session.
  const resolved = await resolveBin();
  const bin = resolved.command;

  written.push(
    await copyTemplate(
      path.join(templatesDir(), "skills", "grove", "SKILL.md"),
      path.join(root, ".claude", "skills", "grove", "SKILL.md"),
      opts.force,
    ),
  );

  written.push(
    await copyTemplate(
      path.join(templatesDir(), "commands", "setup-grove.md"),
      path.join(root, ".claude", "commands", "setup-grove.md"),
      opts.force,
    ),
  );

  const settings = opts.global
    ? path.join(homeClaudeDir(), "settings.json")
    : path.join(root, ".claude", "settings.json");
  written.push(await mergeHooks(settings, bin));

  written.push(await appendGitignore(path.join(root, ".gitignore")));

  // Codex reads AGENTS.md rather than skills, so mirror the essentials there —
  // but only if the file already exists. Creating one uninvited is presumptuous.
  const agents = path.join(root, "AGENTS.md");
  if (await exists(agents)) written.push(await appendAgents(agents, opts.force));

  written.push(...(await removeLegacy(root)));

  const ok = written.every((w) => w.action !== "skipped");

  if (opts.json) {
    printJson({
      ok,
      binary: bin,
      binaryVerified: resolved.verified,
      ...(resolved.shadowedBy ? { shadowedBy: resolved.shadowedBy } : {}),
      files: written,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const entry of written) {
    const mark =
      entry.action === "skipped" ? c.yellow("·") : entry.action === "unchanged" ? c.dim("·") : c.green("✓");
    const rel = path.relative(root, entry.file) || entry.file;
    console.log(`${mark} ${entry.action.padEnd(9)} ${rel}${entry.reason ? c.dim(` (${entry.reason})`) : ""}`);
  }
  console.log();
  console.log(`hooks call ${c.bold(bin)}`);
  if (resolved.shadowedBy) {
    console.log(
      c.yellow(`note: ${resolved.shadowedBy} is on PATH but is not this tool — that name is taken`),
    );
  }
  if (!resolved.verified) {
    console.log(
      c.dim("  nothing on PATH is this package; hooks go through npx. `npm i -g grovekit` to fix."),
    );
  }
  console.log(c.dim(`next: \`/setup-grove\` in Claude Code, or \`${bin} adapt evidence\` by hand`));

  // Non-zero when anything was left alone, so a caller learns the install was
  // partial instead of assuming every file is now what this version ships.
  if (!ok) process.exitCode = 1;
}

function homeClaudeDir(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".claude");
}

async function copyTemplate(from: string, to: string, force: boolean): Promise<Written> {
  const content = await fs.readFile(from, "utf8").catch(() => null);
  if (content === null) return { file: to, action: "skipped", reason: "template missing" };

  const current = await fs.readFile(to, "utf8").catch(() => null);
  if (current === content) return { file: to, action: "unchanged" };
  if (current !== null && !force) {
    return { file: to, action: "skipped", reason: "already exists — pass --force to overwrite" };
  }

  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, content, "utf8");
  return { file: to, action: current === null ? "created" : "updated" };
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };

/**
 * Is this hook command one we wrote, under any name we have ever installed as?
 *
 * Exact, and only ever matching our own commands: a user's hook that merely
 * mentions the tool must survive untouched. Anything else would make `install`
 * a command that quietly edits your settings.
 */
function isOurHookCommand(command: string): boolean {
  return new RegExp(
    `^(${[...BIN_NAMES, `npx --no-install ${PACKAGE_NAME}`, "npx --no-install easy-worktree", "npx --no-install git-grove"].join("|")}) hook (session-start|session-end)$`,
  ).test(command.trim());
}

/** What this version writes. Never a deletion candidate — see `removeLegacy`. */
const CURRENT_ARTIFACTS = [
  path.join(".claude", "skills", "grove"),
  path.join(".claude", "commands", "setup-grove.md"),
];

/** Names this tool shipped under before. Their files compete with the current ones. */
const LEGACY_ARTIFACTS = [
  path.join(".claude", "skills", "easy-worktree"),
  path.join(".claude", "commands", "setup-easy-worktree.md"),
  path.join(".claude", "skills", "git-grove"),
  path.join(".claude", "commands", "setup-git-grove.md"),
];

/**
 * Remove what a previous name left behind.
 *
 * Two skills whose descriptions both say "run stacks per worktree" compete for
 * selection, and the loser is chosen at random — so a rename that leaves the old
 * skill in place is worse than no rename at all.
 *
 * The guard is not paranoia: a careless rename put the *current* command file in
 * the legacy list, so `install` created it and then deleted it in the same run,
 * and the only symptom was a file quietly missing afterwards. Deleting something
 * we just wrote can never be right, so it is refused here rather than trusted to
 * whoever edits the list next.
 */
async function removeLegacy(root: string): Promise<Written[]> {
  const out: Written[] = [];
  for (const rel of LEGACY_ARTIFACTS) {
    if (CURRENT_ARTIFACTS.includes(rel)) continue;
    const file = path.join(root, rel);
    if (!(await exists(file))) continue;
    await fs.rm(file, { recursive: true, force: true });
    out.push({ file, action: "updated", reason: "removed — superseded by the current name" });
  }
  return out;
}

/**
 * Merge our two hook entries into whatever is already in settings.json.
 *
 * Rewriting the file wholesale would silently delete a user's own hooks, so this
 * only ever appends, and only when an identical command is not already present.
 */
async function mergeHooks(file: string, bin: string): Promise<Written> {
  const wanted: Record<string, string> = {
    SessionStart: `${bin} hook session-start`,
    SessionEnd: `${bin} hook session-end`,
  };

  const settings = await readJson<Record<string, unknown>>(file, {});
  const existed = await exists(file);
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  let changed = false;

  for (const [event, command] of Object.entries(wanted)) {
    let entries = Array.isArray(hooks[event]) ? hooks[event] : [];

    // Drop entries that are *ours* under an older binary name. Without this a
    // rename leaves both installed and the session gets its context injected
    // twice — and the stale one keeps working, so nothing ever surfaces it.
    // The pattern is deliberately exact: anything that is not precisely one of
    // our commands belongs to the user and is never touched.
    const before = JSON.stringify(entries);
    entries = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter(
          (h) => h.command === command || !isOurHookCommand(h.command),
        ),
      }))
      .filter((entry) => entry.hooks.length > 0);
    if (JSON.stringify(entries) !== before) changed = true;

    const present = entries.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command === command),
    );
    if (!present) {
      entries.push({ hooks: [{ type: "command", command }] });
      changed = true;
    }
    hooks[event] = entries;
  }

  if (!changed) return { file, action: "unchanged" };

  settings.hooks = hooks;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { file, action: existed ? "updated" : "created" };
}

/**
 * Trap 4, made mechanical: a committed `.wt/state.json` makes a new worktree
 * inherit another's slug and drive its containers.
 */
async function appendGitignore(file: string): Promise<Written> {
  const current = await fs.readFile(file, "utf8").catch(() => null);
  if (current !== null && /^\.wt\/?$/m.test(current)) return { file, action: "unchanged" };

  const block =
    "\n# git-grove per-worktree runtime state. Committing this makes a new\n" +
    "# worktree inherit another's identity and drive its containers.\n.wt/\n";
  await fs.writeFile(file, (current ?? "") + block, "utf8");
  return { file, action: current === null ? "created" : "updated" };
}

async function appendAgents(file: string, force: boolean): Promise<Written> {
  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current.includes(AGENTS_MARKER) && !force) return { file, action: "unchanged" };
  if (current.includes(AGENTS_MARKER)) {
    return { file, action: "unchanged", reason: "section already present" };
  }

  const section = `
${AGENTS_MARKER}
## Worktree stacks

This repo uses \`grove\` (grovekit): every git worktree runs its own full stack
with its own URLs and its own database.

- Read \`.wt/manifest.json\` for URLs and per-service status. Every command takes
  \`--json\`; prefer it.
- \`grove up\` starts and blocks until healthy. \`grove run <cmd>\` injects \`BASE_URL\`,
  \`API_URL\` and \`DATABASE_URL\` and passes the exit code through.
- \`status: ready\` means every service in \`scope\` is ready. A service marked
  \`not-started\` was deliberately left out of scope — nothing is wrong with it.
- Never hardcode a URL or a port; read them from the manifest or the environment.
`;

  await fs.writeFile(file, current.trimEnd() + "\n" + section, "utf8");
  return { file, action: "updated" };
}
