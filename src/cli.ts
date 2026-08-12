#!/usr/bin/env node
import { parseArgs } from "node:util";
import { adapt } from "./commands/adapt.js";
import { down } from "./commands/down.js";
import { doctor } from "./commands/doctor.js";
import { gc } from "./commands/gc.js";
import { hook } from "./commands/hook.js";
import { hydrateCommand } from "./commands/hydrate.js";
import { install } from "./commands/install.js";
import { logs } from "./commands/logs.js";
import { ls } from "./commands/ls.js";
import { newWorktree } from "./commands/new.js";
import { rm } from "./commands/rm.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { up } from "./commands/up.js";
import { ConfigError } from "./core/config.js";
import { ContextError } from "./core/context.js";
import { c, fail } from "./core/output.js";

const VERSION = "0.4.0";

const HELP = `${c.bold("grove")} — every git worktree gets its own stack

${c.dim("USAGE")}
  grove <command> [options]

${c.dim("LIFECYCLE")}
  new <branch>        Create a worktree, hydrate it, start it
  up [services…]      Start the stack and wait until healthy
  down [services…]    Stop containers (keeps volumes, data and leases)
  rm <worktree>       Delete a worktree and everything it owns
  gc                  Reclaim containers, volumes and leases nothing owns

${c.dim("USING A WORKTREE")}
  run <command…>      Run a command with this worktree's env injected
  status              Show what is running (read-only)
  logs [services…]    Show container logs
  ls                  List every worktree and its stack status
  hydrate             Re-copy gitignored files from the main worktree

${c.dim("SETUP")}
  adapt <step>        evidence | decide | render | validate — migrate a repo
  install             Add the agent skill, slash command and hooks
  doctor              Check the environment and the migration

${c.dim("OPTIONS")}
  --json              Machine-readable output (a contract; the table is not)
  --build             Rebuild images before starting            ${c.dim("(up, new)")}
  --no-deps           Start only the named services             ${c.dim("(up)")}
  --timeout <sec>     Health timeout, default 120               ${c.dim("(up, new)")}
  --from <ref>        Base ref for a new branch                 ${c.dim("(new)")}
  --path <dir>        Where to put the worktree                 ${c.dim("(new)")}
  --no-hydrate        Skip copying gitignored files             ${c.dim("(new)")}
  --no-up             Create the worktree without starting it   ${c.dim("(new)")}
  --remove            Remove containers and networks too        ${c.dim("(down)")}
  --delete-branch     Delete the branch as well                 ${c.dim("(rm)")}
  --keep-volumes      Keep the databases                        ${c.dim("(rm)")}
  --dry-run           Report what would happen, change nothing  ${c.dim("(gc, hydrate)")}
  --proxy             Also stop the shared proxy when idle      ${c.dim("(gc)")}
  --env               Print the injected environment            ${c.dim("(status)")}
  --tail <n>          Lines of history, default 50              ${c.dim("(logs)")}
  --follow, -f        Stream logs                               ${c.dim("(logs)")}
  --force             Skip the readiness gate / discard changes ${c.dim("(run, rm)")}
  --out <dir>         Where to write generated files            ${c.dim("(adapt)")}
  --help, -h          Show this help
  --version, -v       Show version

${c.dim("EXAMPLES")}
  grove new feat/login              ${c.dim("# branch + worktree + hydrate + up, one call")}
  grove up --group backend          ${c.dim("# a named set from worktree.toml")}
  grove run pnpm test:e2e           ${c.dim("# BASE_URL/API_URL injected, exit code passed through")}
  grove status --json               ${c.dim("# what an agent should read")}
  grove rm feat/login --delete-branch
  grove gc --dry-run                ${c.dim("# see what has been orphaned")}
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
  // args belong to the child verbatim, so `grove run npm test -- --json` keeps its
  // own `--json`. An explicit `--` forces the split early.
  let ownArgs = argv.slice(1);
  let childArgs: string[] = [];

  if (command === "run") {
    const rest = argv.slice(1);
    const bare = rest.findIndex((a) => !a.startsWith("-"));
    const sep = rest.indexOf("--");

    // Split at whichever comes first. If a bare token leads, everything from it
    // onward is the child command — including any later `--`, which then belongs
    // to the child (`grove run node -e x -- --json`).
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
      from: { type: "string" },
      path: { type: "string" },
      "no-hydrate": { type: "boolean", default: false },
      "no-up": { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
      "keep-volumes": { type: "boolean", default: false },
      proxy: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      run: { type: "boolean", default: false },
      out: { type: "string" },
      heuristic: { type: "boolean", default: false },
      probe: { type: "boolean", default: false },
      global: { type: "boolean", default: false },
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

    case "new":
      await newWorktree({
        json,
        branch: positionals[0] ?? "",
        ...(values.from ? { from: values.from } : {}),
        ...(values.path ? { path: values.path } : {}),
        noHydrate: values["no-hydrate"] === true,
        noUp: values["no-up"] === true,
        build: values.build === true,
        services: values.group ?? [],
        ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
      });
      return;

    case "rm":
      await rm({
        json,
        target: positionals[0] ?? "",
        force: values.force === true,
        deleteBranch: values["delete-branch"] === true,
        keepVolumes: values["keep-volumes"] === true,
      });
      return;

    case "gc":
      await gc({ json, dryRun: values["dry-run"] === true, proxy: values.proxy === true });
      return;

    case "hydrate":
      await hydrateCommand({
        json,
        ...(values.from ? { from: values.from } : {}),
        dryRun: values["dry-run"] === true,
        force: values.force === true,
        run: values.run === true,
      });
      return;

    case "adapt":
      await adapt({
        json,
        step: positionals[0] ?? "",
        ...(positionals[1] ? { file: positionals[1] } : {}),
        ...(values.out ? { out: values.out } : {}),
        heuristic: values.heuristic === true,
        probe: values.probe === true,
        force: values.force === true,
      });
      return;

    case "install":
      await install({ json, force: values.force === true, global: values.global === true });
      return;

    case "hook":
      await hook({ json, event: positionals[0] ?? "" });
      return;

    case "doctor":
      await doctor({ json });
      return;

    default:
      fail(
        { ok: false, error: `unknown command "${command}"`, hint: "run `grove --help`" },
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
