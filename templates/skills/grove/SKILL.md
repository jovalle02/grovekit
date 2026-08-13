---
name: grove
description: Create, run, test, or inspect isolated stacks per git worktree. Use when starting the app, running e2e tests, needing a service URL, creating a worktree for a task, or working on something that needs its own isolated environment.
---

Every worktree in this repo runs its own full stack - own database, own URLs,
nothing shared with any other worktree. All commands accept `--json`; prefer it.

## Several are running at once

That is the point of this tool, and it changes two habits.

**Ports and URLs are per-worktree.** Read them from `.wt/manifest.json` or the
environment every time. A port that was right in one worktree is another
worktree's in the next, so a hardcoded one does not merely break - it reaches
someone else's stack and appears to work.

**A process on a port you did not lease belongs to somebody.** `grove ls --all
--json` says whose. Leave it alone: stopping it takes down a stack somebody is
using, and `grove down` on your own worktree cannot reach it anyway.

## Where am I

Read `.wt/manifest.json`. It is always at the worktree root, so the relative path
resolves correctly no matter which worktree you are in. Use `grove status --json` if
it may be stale.

- file missing, or `status` is not `ready` -> run `grove up` (it blocks until healthy)
- a service is `unhealthy` -> run the command in its `logs` field and report what
  broke. Do not edit tests to work around a broken service.
- a service is `not-started` -> it was deliberately left out of scope. **Nothing is
  wrong with it.** If you need it, add it: `grove up <service>` extends the running
  set without restarting anything.

`status: ready` means every service in `scope` is ready - not every service in the
compose file.

## Starting a new piece of work

    grove new feat/thing --json

One call: creates the branch, adds the worktree, copies the gitignored files it
needs (`.env`, `node_modules`), starts the stack and waits until it is healthy.
The JSON tells you where it landed - `cd` there and work.

Options worth knowing: `--from <ref>` to branch from something other than the
default, `--no-up` to create it without starting anything, `--path <dir>` to
choose the location.

## Database contents in a new worktree

A new worktree gets an **empty** database. Whether that matters was settled once,
during `/setup-grove`, and written into `worktree.toml`:

- **`[seed] from = "..."` is present** - `grove new` copies the databases from
  that worktree before the application starts. Nothing to ask.
- **absent** - a new worktree starts empty, because the data is rebuilt from the
  repo on boot or because the user said they did not need it.

**Do not re-ask this on every `grove new`.** The repo has answered it. Read
`worktree.toml` if you need to know which way.

When it is set, say what the wait will be before you start it. The copy dominates
everything else `grove new` does and scales with the size of the data, not the
repo: a small database adds seconds, a few gigabytes turn a ten-second command
into several minutes with no output in between, and a `--timeout` that was
generous without a copy may not be with one. `grove seed --json` reports the size
without copying anything, so you can say the number before you begin. The `seed`
object in the result says what was copied afterwards.

Two overrides, for the one-off case rather than the standing policy:

    grove new feat/thing --seed-from main --json   # copy, whatever the config says
    grove new feat/thing --no-seed --json          # do not copy

Use them when the user asks for this worktree specifically. If they want it to
be the rule from now on, that is a `[seed] from` line in `worktree.toml` and it
is their decision to make, not yours.

If a worktree already exists and turns out to need the data, `grove seed --from
main` copies into it. That replaces what is in there, so confirm before running
it.

The two databases stay separate either way. Copying shares a starting point, not
a schema, so migrating one branch cannot reach the other.

## Running things

`grove run <cmd...>` injects the worktree's environment and passes the child's exit
code straight through.

    grove run pnpm test:e2e
    grove run pnpm db:seed

Injected: `BASE_URL`, `API_URL`, `WT_URL_<SERVICE>`, `WT_HOST_<SERVICE>`,
`WT_PORT_<SERVICE>`, `WT_NAME`, `WT_BRANCH`, plus anything under `[env]` in
worktree.toml (typically `DATABASE_URL`).

Never hardcode a URL or a port. Read them from the manifest or the environment.

Flags before the command are `grove`'s; from the first bare word onward everything
belongs to the child. `grove run --json node script.js` vs
`grove run node script.js --json`.

## Starting only what you need

Full stacks are expensive and several worktrees may be running at once. Start the
minimum:

    grove up --group backend     # a named set from worktree.toml
    grove up api                 # api plus its dependencies
    grove up api --no-deps       # exactly api

## Cleaning up

`grove down` stops containers and keeps volumes, data and port leases. It is safe
and reversible - do it freely when a stack is no longer needed. `grove up` brings it
back in seconds.

**`down` and `restart` only ever touch your own worktree.** Containers are
addressed by the Compose project name, which is this worktree's slug, and host
processes by this worktree's own ledger - neither can reach another worktree.
So you never need to check with anyone before stopping your stack.

To restart one thing rather than everything, name it:

    grove restart api        # just that service
    grove restart            # this worktree's whole stack

Prefer `restart <service>` over `down` + `up`: it is faster and it says what you
meant.

`grove rm <slug>` is the destructive one: it deletes the worktree, its containers
and its database. It refuses to run on a worktree with uncommitted changes, and
on the one you are standing in. Add `--delete-branch` to drop the branch too.
**Ask before running it.**

`grove gc --dry-run` shows what has been orphaned; `grove gc` reclaims it. It only ever
deletes things it can prove are dead - a container whose worktree it has no
record of is reported and left alone.

`grove ls --json` shows this repo's worktrees. `grove ls --all --json` shows every
worktree on the machine with its ports - that is the one to run when a port is
taken, or when you are about to stop something and want to know whose it is.

## Diagnosing

`grove doctor` checks the environment and the migration: Docker and Compose
versions, whether the compose files merge, whether any service still publishes a
host port, whether wildcard DNS resolves to loopback, and whether the proxy can
read the Docker socket. Run it first when something is inexplicably unreachable.

If a fresh worktree is missing config or dependencies, `grove hydrate` re-copies
them from the main worktree.

**A service reported `not running` while the app still works** is bound to a
hardcoded port instead of its lease. It works today because you have one
worktree up, and collides the moment you start a second. That is a config bug -
report it rather than routing around it, and never free the port by killing what
holds it.

**A stack stuck at `starting` with no error** is usually a crashed child under a
parent that stayed alive. The stuck protocol in [`verify.md`](verify.md) says
where the child's own logs are.

Three references, for when the port wiring itself needs work:

- [`discovery.md`](discovery.md) - finding every port and whether grove can move it
- [`config.md`](config.md) - writing `worktree.toml`, and the collisions to check
- [`verify.md`](verify.md) - the listener audit, the two-worktree test, the stuck protocol

Re-running `/setup-grove` redoes all of it.
