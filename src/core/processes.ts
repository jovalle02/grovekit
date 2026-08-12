import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { execSafe } from "./exec.js";
import { readJson, withLock, writeJson } from "./lock.js";
import { wtDir } from "./paths.js";

export interface ProcessRecord {
  service: string;
  pid: number;
  command: string;
  /** Log file, relative to the worktree root. */
  log: string;
  startedAt: string;
}

type Ledger = Record<string, ProcessRecord>;

const ledgerFile = (root: string) => path.join(wtDir(root), "processes.json");
export const logFile = (root: string, service: string) =>
  path.join(wtDir(root), "logs", `${service}.log`);

export async function readProcesses(root: string): Promise<Ledger> {
  return readJson<Ledger>(ledgerFile(root), {});
}

/**
 * Whether a pid is still ours.
 *
 * Signal 0 asks the kernel "may I signal this process" without sending
 * anything, which is the cheapest liveness test there is. It cannot tell a
 * recycled pid from the original — but the window for that is a machine reboot
 * plus 32k process launches, and the cost of being wrong is a stale row in a
 * status table.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Start a service this tool does not containerise, and remember its pid.
 *
 * Detached and with its output redirected to a file, because `grove up` has to
 * return: the process outlives the command that started it, exactly as a
 * container does. That is what makes `grove new` a single command rather than a
 * setup step followed by "now run this in another terminal".
 */
export async function startProcess(
  root: string,
  service: string,
  command: string,
  env: Record<string, string>,
): Promise<ProcessRecord> {
  const log = logFile(root, service);
  await fs.mkdir(path.dirname(log), { recursive: true });

  // Not the command directly — a supervisor, which then starts the command.
  const child = spawn(process.execPath, ["-e", SUPERVISOR, log, command], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });

  // Let `grove up` exit without waiting on it.
  child.unref();

  if (child.pid === undefined) throw new Error(`could not start \`${command}\``);

  const record: ProcessRecord = {
    service,
    pid: child.pid,
    command,
    log: path.relative(root, log).replace(/\\/g, "/"),
    startedAt: new Date().toISOString(),
  };

  await update(root, (ledger) => {
    ledger[service] = record;
  });
  return record;
}

/**
 * A supervisor process, passed to `node -e`.
 *
 * It exists because on Windows the two properties `grove up` needs are mutually
 * exclusive in a single spawn — measured, not assumed:
 *
 *   attached   output is captured, but the process dies when `grove` exits
 *   detached   the process survives, but its output goes nowhere, because a
 *              detached process has no console and the handles it inherited
 *              write into nothing
 *
 * So `grove` detaches *this*, and this opens the log itself and runs the real
 * command as an ordinary attached child. Both properties then hold, on every
 * platform. It is inlined rather than shipped as a file so that the path is the
 * same whether the CLI is running from `dist/` or through tsx from `src/`.
 *
 * With `node -e <script> a b`, argv is [execPath, a, b] — there is no script
 * path in the middle.
 */
const SUPERVISOR = `
const { spawn } = require("child_process");
const fs = require("fs");
const [log, ...rest] = process.argv.slice(1);
const fd = fs.openSync(log, "w");
const child = spawn(rest.join(" "), {
  shell: true,
  stdio: ["ignore", fd, fd],
  windowsHide: true,
});
// Exit with the child, so a live supervisor always means a live service — which
// is exactly what the pid in .wt/processes.json is taken to mean.
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code === null ? 0 : code)));
child.on("error", (err) => {
  fs.writeSync(fd, "grove: could not start: " + err.message + "\\n");
  process.exit(1);
});
`;

/**
 * Stop a service we started, and everything it spawned.
 *
 * The pid we hold is the supervisor, not the application. Build tools commonly
 * launch the real process as a child, and an orchestrator may start a dozen.
 * Signalling only the pid leaves all of them running and holding the ports —
 * which looks exactly like `grove down` having done nothing.
 */
export async function stopProcess(root: string, service: string): Promise<boolean> {
  const ledger = await readProcesses(root);
  const record = ledger[service];
  if (!record) return false;

  if (isAlive(record.pid)) {
    if (process.platform === "win32") {
      await execSafe("taskkill", ["/PID", String(record.pid), "/T", "/F"]);
    } else {
      // Negative pid signals the process group created by `detached`.
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch {
        try {
          process.kill(record.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  }

  await update(root, (l) => {
    delete l[service];
  });
  return true;
}

/** Drop rows whose process has exited, so `status` does not report ghosts. */
export async function reapProcesses(root: string): Promise<void> {
  const ledger = await readProcesses(root);
  const dead = Object.values(ledger).filter((r) => !isAlive(r.pid));
  if (dead.length === 0) return;
  await update(root, (l) => {
    for (const record of dead) delete l[record.service];
  });
}

export async function tailLog(root: string, service: string, lines: number): Promise<string[]> {
  const text = await fs.readFile(logFile(root, service), "utf8").catch(() => "");
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines);
}

async function update(root: string, fn: (ledger: Ledger) => void): Promise<void> {
  const file = ledgerFile(root);
  await withLock(file, async () => {
    const ledger = await readJson<Ledger>(file, {});
    fn(ledger);
    await writeJson(file, ledger);
  });
}
