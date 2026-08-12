import path from "node:path";
import { loadContext } from "../core/context.js";
import { mainWorktree } from "../core/git.js";
import { c, fail, printJson } from "../core/output.js";
import {
  detectDatabases,
  formatBytes,
  hasData,
  measure,
  transfer,
  type DatabaseService,
  type SeedSize,
} from "../core/seed.js";
import { resolveWorktree } from "../core/worktrees.js";

export interface SeededDatabase {
  service: string;
  engine: string;
  bytes: number;
  rows: number | null;
  copied: boolean;
  error?: string;
  logs?: string[];
}

export interface SeedReport {
  ok: boolean;
  /** Worktree the data came from, or null when nothing was copied. */
  from: string | null;
  databases: SeededDatabase[];
  /** Set when the whole step was a no-op, explaining why. */
  skipped?: string;
}

export interface SeedPlan {
  sourceRoot: string;
  sourceLabel: string;
  pairs: { source: DatabaseService; size: SeedSize }[];
  totalBytes: number;
}

/**
 * Work out whether there is data worth copying, without copying it.
 *
 * Separate from the copy so `grove new` can ask before doing it: the question
 * "this will take a while, do you want it" is only worth asking once the answer
 * to "is there anything there" is yes.
 */
export async function planSeed(
  selector: string,
  cwd: string,
  opts: {
    /**
     * Skip databases that look empty.
     *
     * True when deciding whether to *offer* a copy nobody asked for: an
     * untouched Postgres database is several megabytes of system catalogues,
     * and interrupting someone to offer a copy of that is noise.
     *
     * False when a source was named. Someone who wrote `--seed-from main` has
     * already decided, and a size heuristic that silently overrules them
     * produces the worst outcome available: a command that reports success and
     * did not do the thing.
     */
    onlyWithData: boolean;
  },
): Promise<SeedPlan | null> {
  const source = await resolveWorktree(selector, cwd);
  const ctx = await loadContext(source.path);

  const databases = await detectDatabases(ctx);
  const pairs: SeedPlan["pairs"] = [];

  for (const db of databases) {
    if (!db.running) continue;
    const size = await measure(db);

    // A source that was named gets copied even when it cannot be measured. The
    // probe failing says nothing about whether the dump will: it is one more
    // reason to attempt the copy and report a real error, rather than to cancel
    // it and report nothing.
    if (!size) {
      if (!opts.onlyWithData) pairs.push({ source: db, size: { bytes: 0, rows: null } });
      continue;
    }
    if (opts.onlyWithData && !hasData(db, size)) continue;
    pairs.push({ source: db, size });
  }

  if (pairs.length === 0) return null;
  return {
    sourceRoot: source.path,
    sourceLabel: source.slug ?? source.branch,
    pairs,
    totalBytes: pairs.reduce((sum, p) => sum + p.size.bytes, 0),
  };
}

export interface SeedCheck {
  ok: boolean;
  /** Worktree the data would come from. */
  from: string | null;
  /** Every database found there, running or not. */
  databases: {
    service: string;
    engine: string;
    running: boolean;
    bytes: number | null;
    rows: number | null;
    size: string | null;
    /** False when it looks like an untouched database - nothing worth copying. */
    hasData: boolean;
  }[];
  /** Set when there is nothing to report, explaining why. */
  note?: string;
}

/**
 * What a copy would find, without copying anything.
 *
 * This exists for the agent, and it exists because the alternative is guessing.
 * `grove new` cannot ask an agent whether to copy - a prompt nobody is reading is
 * a hang - so the question has to be asked one level up, in the session, by
 * something that knows there is a database and how big it is. Without a
 * read-only way to find that out, an agent either interrupts about repos that
 * have no database, or quietly decides for the user. Both are worse than asking
 * a specific question with a number in it.
 */
export async function checkSeed(selector: string, cwd: string): Promise<SeedCheck> {
  let source;
  try {
    source = await resolveWorktree(selector, cwd);
  } catch (err) {
    return { ok: false, from: null, databases: [], note: (err as Error).message };
  }

  const ctx = await loadContext(source.path);
  const databases = await detectDatabases(ctx);
  const label = source.slug ?? source.branch;

  if (databases.length === 0) {
    return {
      ok: true,
      from: label,
      databases: [],
      note: "no database services in this stack, so there is nothing to copy",
    };
  }

  const rows: SeedCheck["databases"] = [];
  for (const db of databases) {
    const size = db.running ? await measure(db) : null;
    rows.push({
      service: db.service,
      engine: db.engine,
      running: db.running,
      bytes: size?.bytes ?? null,
      rows: size?.rows ?? null,
      size: size ? formatBytes(size.bytes) : null,
      hasData: size ? hasData(db, size) : false,
    });
  }

  return {
    ok: true,
    from: label,
    databases: rows,
    ...(rows.some((r) => r.running) ? {} : { note: "nothing is running there, so nothing can be read" }),
  };
}

export interface SeedOptions {
  plan: SeedPlan;
  /** Worktree receiving the data. Its database containers must already be running. */
  targetRoot: string;
  quiet: boolean;
}

/**
 * Copy every database in the plan into the target worktree.
 *
 * Matched by service name, which is the only stable identifier across two
 * worktrees: container names carry the project slug and differ by definition.
 */
export async function seedDatabases(opts: SeedOptions): Promise<SeedReport> {
  const targetCtx = await loadContext(opts.targetRoot);
  const targets = await detectDatabases(targetCtx);

  const databases: SeededDatabase[] = [];

  for (const { source, size } of opts.plan.pairs) {
    const target = targets.find((t) => t.service === source.service);
    const row: SeededDatabase = {
      service: source.service,
      engine: source.engine,
      bytes: size.bytes,
      rows: size.rows,
      copied: false,
    };

    if (!target) {
      row.error = `this worktree has no \`${source.service}\` container to copy into`;
      databases.push(row);
      continue;
    }
    if (!target.running) {
      row.error = `\`${source.service}\` is not running here yet`;
      databases.push(row);
      continue;
    }
    if (target.container === source.container) {
      row.error = "source and target are the same container";
      databases.push(row);
      continue;
    }

    if (!opts.quiet) {
      const rows = size.rows ? `, about ${size.rows.toLocaleString("en-US")} rows` : "";
      console.log(
        c.dim(`copying ${source.service} from ${opts.plan.sourceLabel} (${formatBytes(size.bytes)}${rows})...`),
      );
    }

    const result = await transfer(source, target, progressReporter(opts.quiet));
    row.copied = result.ok;
    if (!result.ok) {
      row.error = result.error ?? "the copy failed";
      if (result.logs) row.logs = result.logs;
    } else if (!opts.quiet) {
      console.log(`  ${c.green("ok")} ${source.service} ${c.dim(`(${formatBytes(result.bytes)} transferred)`)}`);
    }
    databases.push(row);
  }

  return {
    ok: databases.every((d) => d.copied),
    from: opts.plan.sourceLabel,
    databases,
  };
}

export interface SeedCommandOptions {
  json: boolean;
  /** Copy from this worktree into the current one. Absent means report only. */
  from?: string;
  /** Skip the confirmation before overwriting this worktree's data. */
  force: boolean;
}

/**
 * `grove seed` - report what could be copied, or copy it.
 *
 * Read-only without `--from`, because that is the safe reading of a bare verb and
 * because reporting is what the interesting caller wants: an agent deciding
 * whether it has a question to ask the user. Naming a source is the deliberate
 * act, and it is the one that overwrites this worktree's data.
 */
export async function seedCommand(opts: SeedCommandOptions): Promise<void> {
  const ctx = await loadContext();

  if (!opts.from) {
    const check = await checkSeed(await mainWorktree(ctx.root), ctx.root);
    if (opts.json) {
      printJson(check);
      return;
    }
    printCheck(check);
    return;
  }

  const source = await resolveWorktree(opts.from, ctx.root);
  if (path.resolve(source.path) === path.resolve(ctx.root)) {
    fail({ ok: false, error: "that is this worktree - name the one to copy from" }, opts.json);
  }

  const plan = await planSeed(opts.from, ctx.root, { onlyWithData: false });
  if (!plan) {
    const payload = {
      ok: true,
      from: source.slug ?? source.branch,
      databases: [],
      skipped: "nothing to copy: no database is running there",
    };
    if (opts.json) printJson(payload);
    else console.log(c.dim(payload.skipped));
    return;
  }

  // The restore replaces what is here. Interactively that deserves a question;
  // with --json the caller named a source explicitly, which is the same answer.
  if (!opts.json && !opts.force && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const what = plan.pairs.map((p) => `${p.source.service} (${formatBytes(p.size.bytes)})`).join(", ");
    console.log(`This replaces the contents of ${what} in this worktree, from ${plan.sourceLabel}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Continue? ${c.dim("[y/N]")} `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log(c.dim("nothing copied"));
      return;
    }
  }

  const report = await seedDatabases({ plan, targetRoot: ctx.root, quiet: opts.json });
  if (opts.json) printJson(report);
  if (!report.ok) process.exitCode = 1;
}

function printCheck(check: SeedCheck): void {
  if (check.note && check.databases.length === 0) {
    console.log(c.dim(check.note));
    return;
  }

  console.log(`${c.bold(check.from ?? "?")} ${c.dim("- what a new worktree could start from")}`);
  for (const db of check.databases) {
    const state = !db.running
      ? c.dim("not running")
      : db.hasData
        ? `${db.size}${db.rows ? c.dim(`, about ${db.rows.toLocaleString("en-US")} rows`) : ""}`
        : c.dim(`${db.size} - looks empty`);
    console.log(`  ${db.service} ${c.dim(`(${db.engine})`)}  ${state}`);
  }
  console.log();
  console.log(c.dim(`copy it with: grove new <branch> --seed-from ${check.from ?? "<worktree>"}`));
}

/**
 * Progress on a stream whose total is unknown.
 *
 * Reported every 25 MB rather than on every chunk: a dump emits chunks faster
 * than a terminal can scroll, and the useful information is only "it is still
 * moving, and this is how far it has got".
 */
function progressReporter(quiet: boolean): ((bytes: number) => void) | undefined {
  if (quiet) return undefined;
  const step = 25 * 1024 * 1024;
  let next = step;
  return (bytes) => {
    if (bytes < next) return;
    next = bytes + step;
    console.log(c.dim(`  ${formatBytes(bytes)} transferred...`));
  };
}
