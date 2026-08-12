import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream child output to our own stdio instead of capturing it. */
  inherit?: boolean;
  /**
   * Run through the platform shell. Needed on Windows for `.cmd` shims such as
   * npm/pnpm/yarn; never used for `docker`/`git`, which are real executables and
   * are safer spawned directly.
   */
  shell?: boolean;
  timeoutMs?: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

export function exec(
  file: string,
  args: string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: opts.shell ?? false,
      windowsHide: true,
    };

    const child = spawn(file, args, spawnOpts);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Same as `exec`, but a missing executable is reported as exit 127 rather than a
 * rejected promise. For probing tools that may legitimately be absent — a machine
 * with no Docker still has to be able to run `grove gc` over its leases.
 */
export async function execSafe(
  file: string,
  args: string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  try {
    return await exec(file, args, opts);
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
}

/** Same as `exec`, but a non-zero exit throws. */
export async function execOrThrow(
  file: string,
  args: string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const result = await exec(file, args, opts);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
    throw new ExecError(`\`${file} ${args.join(" ")}\` exited ${result.code}\n${detail}`, result);
  }
  return result;
}

export async function which(cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const { code } = await exec(probe, [cmd]);
    return code === 0;
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
