#!/usr/bin/env node
import { parseArgs } from "node:util";
import { down } from "./commands/down.js";
import { doctor } from "./commands/doctor.js";
import { logs } from "./commands/logs.js";
import { ls } from "./commands/ls.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { up } from "./commands/up.js";
import { ConfigError } from "./core/config.js";
import { ContextError } from "./core/context.js";
import { c, fail } from "./core/output.js";

const VERSION = "0.1.0";

const HELP = `${c.bold("wt")} — every git worktree gets its own stack

${c.dim("USAGE")}
  wt <command> [options]

${c.dim("COMMANDS")}
  up [services…]      Start the stack and wait until healthy
  down [services…]    Stop containers (keeps volumes, data and leases)
  run <command…>      Run a command with this worktree's env injected
  status              Show what is running (read-only)
  logs [services…]    Show container logs
  ls                  List every worktree and its stack status
  doctor              Check the environment and the migration

${c.dim("OPTIONS")}
  --json              Machine-readable output (a contract; the table is not)
  --build             Rebuild images before starting            ${c.dim("(up)")}
  --no-deps           Start only the named services             ${c.dim("(up)")}
  --timeout <sec>     Health timeout, default 120               ${c.dim("(up)")}
  --remove            Remove containers and networks too        ${c.dim("(down)")}
  --env               Print the injected environment            ${c.dim("(status)")}
  --tail <n>          Lines of history, default 50              ${c.dim("(logs)")}
  --follow, -f        Stream logs                               ${c.dim("(logs)")}
  --force             Skip the readiness gate                   ${c.dim("(run)")}
  --help, -h          Show this help
  --version, -v       Show version

${c.dim("EXAMPLES")}
  wt up                          ${c.dim("# whole stack")}
  wt up api db                   ${c.dim("# those plus their dependencies")}
  wt up --group backend          ${c.dim("# a named set from worktree.toml")}
  wt run pnpm test:e2e           ${c.dim("# BASE_URL/API_URL injected, exit code passed through")}
  wt status --json               ${c.dim("# what an agent should read")}
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  // For `run`, only leading flags are ours; from the first bare token onward the
  // args belong to the child verbatim, so `wt run npm test -- --json` keeps its
  // own `--json`. An explicit `--` forces the split early.
  let ownArgs = argv.slice(1);
  let childArgs: string[] = [];

  if (command === "run") {
    const rest = argv.slice(1);
    const bare = rest.findIndex((a) => !a.startsWith("-"));
    const sep = rest.indexOf("--");

    // Split at whichever comes first. If a bare token leads, everything from it
    // onward is the child command — including any later `--`, which then belongs
    // to the child (`wt run node -e x -- --json`).
    const candidates = [bare, sep].filter((i) => i !== -1);
    const cut = candidates.length === 0 ? -1 : Math.min(...candidates);

    if (cut === -1) {
      ownArgs = rest;
    } else {
      ownArgs = rest.slice(0, cut);
      childArgs = rest[cut] === "--" ? rest.slice(cut + 1) : rest.slice(cut);
    }
  }

  const { values, positionals } = parseArgs({
    args: ownArgs,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      build: { type: "boolean", default: false },
      "no-deps": { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
      env: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      group: { type: "string", multiple: true },
      timeout: { type: "string" },
      tail: { type: "string", default: "50" },
    },
  });

  const json = values.json === true;
  // `--group x` and a bare positional are the same thing to resolveSelection.
  const services = [...positionals, ...(values.group ?? [])];

  switch (command) {
    case "up":
      await up({
        json,
        services,
        build: values.build === true,
        noDeps: values["no-deps"] === true,
        ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
      });
      return;

    case "down":
      await down({ json, services, remove: values.remove === true });
      return;

    case "run":
      await run({ json, argv: childArgs, force: values.force === true });
      return;

    case "status":
      await status({ json, env: values.env === true });
      return;

    case "logs":
      await logs({
        json,
        services,
        tail: Number(values.tail ?? "50"),
        follow: values.follow === true,
      });
      return;

    case "ls":
      await ls({ json });
      return;

    case "doctor":
      await doctor({ json });
      return;

    default:
      fail(
        { ok: false, error: `unknown command "${command}"`, hint: "run `wt --help`" },
        json,
      );
  }
}

main().catch((err: unknown) => {
  const json = process.argv.includes("--json");

  if (err instanceof ContextError || err instanceof ConfigError) {
    fail(
      {
        ok: false,
        error: err.message,
        ...(err instanceof ContextError && err.hint ? { hint: err.hint } : {}),
      },
      json,
    );
  }

  fail({ ok: false, error: err instanceof Error ? err.message : String(err) }, json);
});
