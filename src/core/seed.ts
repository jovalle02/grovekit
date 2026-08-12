import { spawn } from "node:child_process";
import { composePs } from "./compose.js";
import { execSafe } from "./exec.js";
import type { Context } from "./context.js";

/**
 * Copy a database from one worktree into another.
 *
 * The problem this solves is the one thing per-worktree isolation cannot give
 * you for free: a new worktree starts with an empty volume. If the data comes
 * from the repo - migrations plus a seed script that run on boot - that is
 * exactly right and nothing here is needed. If it came from a dump somebody
 * restored by hand, the new worktree is useless until the same hour of work is
 * repeated, and people go back to sharing one database and stepping on each
 * other's migrations.
 *
 * So: copy, do not share. Each worktree keeps its own container, its own volume
 * and its own schema; only the starting data is the same. A migration on one
 * branch cannot reach the other.
 *
 * The transfer is a dump piped into a restore between two live containers,
 * rather than a copy of the volume directory. A volume copy needs the source
 * stopped to be consistent, which means reaching into a worktree somebody else
 * is using; `pg_dump` and its equivalents take a transactional snapshot of a
 * running server and touch nothing.
 */

export type Engine = "postgres" | "mysql" | "mongo";

export interface Credentials {
  user: string;
  password: string;
  database: string;
}

export interface DatabaseService {
  /** Service name as declared in worktree.toml. */
  service: string;
  engine: Engine;
  /** Container name, which is what `docker exec` needs. */
  container: string;
  running: boolean;
  credentials: Credentials;
}

export interface SeedSize {
  bytes: number;
  /** Live-row estimate. Null when the engine cannot answer cheaply. */
  rows: number | null;
}

/**
 * Bytes an empty database occupies, per engine.
 *
 * A fresh Postgres database is not zero bytes - the system catalogues are real
 * data. Copying one is pointless, so anything at or under this counts as empty.
 */
const EMPTY_BYTES: Record<Engine, number> = {
  postgres: 12_000_000,
  mysql: 1_000_000,
  mongo: 1_000_000,
};

export function engineFromImage(image: string): Engine | null {
  if (/postgres|postgis|timescale/i.test(image)) return "postgres";
  if (/mysql|mariadb|percona/i.test(image)) return "mysql";
  if (/mongo/i.test(image)) return "mongo";
  return null;
}

export function credentialsFrom(engine: Engine, env: Record<string, string>): Credentials {
  if (engine === "postgres") {
    const user = env.POSTGRES_USER ?? "postgres";
    return {
      user,
      password: env.POSTGRES_PASSWORD ?? "",
      database: env.POSTGRES_DB ?? user,
    };
  }
  if (engine === "mysql") {
    // A compose file that sets MYSQL_USER creates that user with MYSQL_PASSWORD;
    // one that sets only MYSQL_ROOT_PASSWORD leaves root as the only account.
    // Dumping needs whichever of the two actually exists.
    const user = env.MYSQL_USER ?? "root";
    return {
      user,
      password: (env.MYSQL_USER ? env.MYSQL_PASSWORD : env.MYSQL_ROOT_PASSWORD) ?? "",
      database: env.MYSQL_DATABASE ?? "",
    };
  }
  return {
    user: env.MONGO_INITDB_ROOT_USERNAME ?? "",
    password: env.MONGO_INITDB_ROOT_PASSWORD ?? "",
    database: env.MONGO_INITDB_DATABASE ?? "test",
  };
}

/** Image and environment of a running container, read from Docker rather than from the compose file. */
async function inspect(container: string): Promise<{ image: string; env: Record<string, string> } | null> {
  const { code, stdout } = await execSafe("docker", [
    "inspect",
    "--format",
    "{{json .Config}}",
    container,
  ]);
  if (code !== 0) return null;

  try {
    const config = JSON.parse(stdout) as { Image?: string; Env?: string[] };
    const env: Record<string, string> = {};
    for (const entry of config.Env ?? []) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return { image: config.Image ?? "", env };
  } catch {
    return null;
  }
}

/**
 * The databases in a worktree's stack.
 *
 * Reads the running container rather than the compose file, because that is
 * where the truth is: `env_file`, `extends` and shell interpolation all resolve
 * before a container gets its environment, and re-deriving that here would be a
 * second, worse implementation of what Docker already did.
 */
export async function detectDatabases(ctx: Context): Promise<DatabaseService[]> {
  const declared = ctx.config.services.filter((s) => s.runtime === "compose" && s.layer === "data");
  if (declared.length === 0) return [];

  const containers = await composePs(ctx);
  const found: DatabaseService[] = [];

  for (const svc of declared) {
    const row = containers.find((c) => c.service === svc.name);
    if (!row || !row.name) continue;

    const details = await inspect(row.name);
    if (!details) continue;

    const engine = engineFromImage(details.image);
    if (engine === null) continue;

    found.push({
      service: svc.name,
      engine,
      container: row.name,
      running: row.state === "running",
      credentials: credentialsFrom(engine, details.env),
    });
  }

  return found;
}

/** A query whose single value is the size of the database in bytes. */
function sizeQuery(db: DatabaseService): string[] {
  const { credentials: cred } = db;
  if (db.engine === "postgres") {
    return [
      "psql", "-U", cred.user, "-d", cred.database, "-tAc",
      `select pg_database_size('${cred.database}')`,
    ];
  }
  if (db.engine === "mysql") {
    return [
      "mysql", "-u", cred.user, "-N", "-B", "-e",
      "select coalesce(sum(data_length + index_length), 0) from information_schema.tables " +
        `where table_schema = '${cred.database}'`,
    ];
  }
  return ["mongosh", "--quiet", "--eval", "print(db.stats().dataSize)"];
}

function rowQuery(db: DatabaseService): string[] | null {
  const { credentials: cred } = db;
  if (db.engine === "postgres") {
    // n_live_tup is an estimate maintained by the statistics collector. Cheap on
    // any size of database, which an exact count is not.
    return [
      "psql", "-U", cred.user, "-d", cred.database, "-tAc",
      "select coalesce(sum(n_live_tup), 0) from pg_stat_user_tables",
    ];
  }
  if (db.engine === "mysql") {
    return [
      "mysql", "-u", cred.user, "-N", "-B", "-e",
      "select coalesce(sum(table_rows), 0) from information_schema.tables " +
        `where table_schema = '${cred.database}'`,
    ];
  }
  return ["mongosh", "--quiet", "--eval", "print(db.stats().objects)"];
}

/** Environment that lets the client tools authenticate without a password on the command line. */
function clientEnv(db: DatabaseService): string[] {
  const { credentials: cred } = db;
  if (db.engine === "postgres") return ["-e", `PGPASSWORD=${cred.password}`];
  if (db.engine === "mysql") return ["-e", `MYSQL_PWD=${cred.password}`];
  return [];
}

async function query(db: DatabaseService, command: string[]): Promise<number | null> {
  const { code, stdout } = await execSafe("docker", [
    "exec",
    ...clientEnv(db),
    db.container,
    ...command,
  ]);
  if (code !== 0) return null;
  const value = Number(stdout.trim().split("\n").pop());
  return Number.isFinite(value) ? value : null;
}

/**
 * How much data is in there, and therefore whether copying it is worth offering.
 *
 * Size is the honest signal. A row estimate is nicer to read but can report zero
 * for a database that was just filled and not yet analysed, so it informs the
 * message and never the decision.
 */
export async function measure(db: DatabaseService): Promise<SeedSize | null> {
  const bytes = await query(db, sizeQuery(db));
  if (bytes === null) return null;
  const rowCommand = rowQuery(db);
  const rows = rowCommand ? await query(db, rowCommand) : null;
  return { bytes, rows };
}

export function hasData(db: DatabaseService, size: SeedSize): boolean {
  return size.bytes > EMPTY_BYTES[db.engine];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function dumpCommand(db: DatabaseService): string[] {
  const { credentials: cred } = db;
  if (db.engine === "postgres") {
    // Custom format: compressed on the way out, and restorable with --clean, so
    // the target does not have to be empty.
    return ["pg_dump", "-U", cred.user, "-d", cred.database, "-Fc", "--no-owner", "--no-acl"];
  }
  if (db.engine === "mysql") {
    return ["mysqldump", "-u", cred.user, "--single-transaction", "--routines", cred.database];
  }
  const auth = cred.user
    ? ["--username", cred.user, "--password", cred.password, "--authenticationDatabase", "admin"]
    : [];
  return ["mongodump", "--db", cred.database, "--archive", ...auth];
}

function restoreCommand(db: DatabaseService): string[] {
  const { credentials: cred } = db;
  if (db.engine === "postgres") {
    return [
      "pg_restore", "-U", cred.user, "-d", cred.database,
      "--clean", "--if-exists", "--no-owner", "--no-acl",
    ];
  }
  if (db.engine === "mysql") {
    return ["mysql", "-u", cred.user, cred.database];
  }
  const auth = cred.user
    ? ["--username", cred.user, "--password", cred.password, "--authenticationDatabase", "admin"]
    : [];
  return ["mongorestore", "--archive", "--drop", ...auth];
}

export interface TransferResult {
  ok: boolean;
  bytes: number;
  error?: string;
  logs?: string[];
}

/**
 * Stream a dump from one container straight into a restore in another.
 *
 * Nothing lands on disk: the two `docker exec` processes are connected by a
 * pipe, so a database bigger than the free space on the machine still copies.
 * The byte count comes from the pipe itself, which is the only progress signal
 * available - `pg_dump` cannot say how much is left because it does not know.
 */
export function transfer(
  from: DatabaseService,
  to: DatabaseService,
  onProgress?: (bytes: number) => void,
): Promise<TransferResult> {
  return new Promise((resolve) => {
    const dump = spawn(
      "docker",
      ["exec", ...clientEnv(from), from.container, ...dumpCommand(from)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const restore = spawn(
      "docker",
      ["exec", "-i", ...clientEnv(to), to.container, ...restoreCommand(to)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    let bytes = 0;
    let dumpErr = "";
    let restoreErr = "";
    let settled = false;

    dump.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      onProgress?.(bytes);
    });
    dump.stdout.pipe(restore.stdin);

    dump.stderr.on("data", (d: Buffer) => (dumpErr += d.toString()));
    restore.stderr.on("data", (d: Buffer) => (restoreErr += d.toString()));

    const finish = (result: TransferResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const spawnFailure = (which: string) => (err: Error) => {
      dump.kill();
      restore.kill();
      finish({ ok: false, bytes, error: `could not run ${which}: ${err.message}` });
    };
    dump.on("error", spawnFailure("the dump"));
    restore.on("error", spawnFailure("the restore"));

    let dumpCode: number | null = null;
    dump.on("close", (code) => (dumpCode = code ?? 1));

    restore.on("close", (code) => {
      const failed = code !== 0 || (dumpCode !== null && dumpCode !== 0);
      if (!failed) return finish({ ok: true, bytes });

      // Whichever end failed, the useful text is at the bottom of its stderr.
      const which = dumpCode !== null && dumpCode !== 0 ? "dump" : "restore";
      const text = (which === "dump" ? dumpErr : restoreErr).trim();
      finish({
        ok: false,
        bytes,
        error: `the ${which} failed (exit ${which === "dump" ? dumpCode : code})`,
        logs: text ? text.split("\n").slice(-12) : [],
      });
    });
  });
}
