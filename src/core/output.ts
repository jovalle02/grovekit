import type { ErrorPayload, Manifest, ServiceStatus } from "../types.js";

const useColor =
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.stdout.isTTY === true;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
  cyan: wrap("36"),
};

const STATUS_STYLE: Record<ServiceStatus, (s: string) => string> = {
  ready: c.green,
  starting: c.yellow,
  unhealthy: c.red,
  stopped: c.dim,
  "not-started": c.dim,
};

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell))))
      .join("  ")
      .trimEnd();

  return [c.dim(line(headers)), ...rows.map(line)].join("\n");
}

/** Width ignoring ANSI escapes, so coloured cells still align. */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function printManifest(m: Manifest): void {
  const mark = m.status === "ready" ? c.green("✓") : m.status === "unhealthy" ? c.red("✗") : c.yellow("…");
  console.log(`${mark} ${c.bold(m.worktree)} ${c.dim(`(branch: ${m.branch})`)}`);
  console.log();

  const rows = m.services.map((s) => [
    s.layer,
    s.name,
    s.url ?? s.hostAddress ?? c.dim("—"),
    // A host process is not started by this tool, so `not-started` there means
    // "you have not launched it", not "something is wrong". Say which it is
    // rather than leaving the reader to infer it from the status word.
    s.runtime === "host"
      ? s.status === "ready"
        ? c.green("listening")
        : c.dim("not running")
      : STATUS_STYLE[s.status](s.status),
  ]);
  console.log(indent(table(["LAYER", "SERVICE", "URL", "STATUS"], rows)));
  console.log();

  const failed = m.services.filter((s) => s.status === "unhealthy");
  for (const svc of failed) {
    console.log(c.red(`  ${svc.name} did not become healthy:`));
    for (const l of svc.lastLogs?.slice(-15) ?? []) console.log(c.dim(`    ${l}`));
    console.log(c.dim(`    → full logs: ${svc.logs}`));
    console.log();
  }

  if (m.rendered?.length) {
    console.log(c.dim(`  generated: ${m.rendered.join(", ")}`));
  }
  console.log(c.dim(`  manifest: .wt/manifest.json`));
}

function indent(s: string, by = "  "): string {
  return s
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function fail(payload: ErrorPayload, json: boolean): never {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(c.red(`error: ${payload.error}`));
    for (const l of payload.logs ?? []) console.error(c.dim(`  ${l}`));
    if (payload.hint) console.error(c.dim(`hint: ${payload.hint}`));
  }
  process.exit(1);
}
