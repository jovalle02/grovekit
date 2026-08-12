import { loadContext } from "../core/context.js";
import { c } from "../core/output.js";
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
