---
name: easy-worktree
description: Create, run, test, or inspect isolated stacks per git worktree. Use when starting the app, running e2e tests, needing a service URL, creating a worktree for a task, or working on something that needs its own isolated environment.
---

Every worktree in this repo runs its own full stack — own database, own URLs,
nothing shared with any other worktree. All commands accept `--json`; prefer it.

## Where am I

Read `.wt/manifest.json`. It is always at the worktree root, so the relative path
resolves correctly no matter which worktree you are in. Use `wt status --json` if
it may be stale.

- file missing, or `status` is not `ready` → run `wt up` (it blocks until healthy)
- a service is `unhealthy` → run the command in its `logs` field and report what
  broke. Do not edit tests to work around a broken service.
- a service is `not-started` → it was deliberately left out of scope. **Nothing is
  wrong with it.** If you need it, add it: `wt up <service>` extends the running
  set without restarting anything.

`status: ready` means every service in `scope` is ready — not every service in the
compose file.

## Starting a new piece of work

    wt new feat/thing --json

One call: creates the branch, adds the worktree, copies the gitignored files it
needs (`.env`, `node_modules`), starts the stack and waits until it is healthy.
The JSON tells you where it landed — `cd` there and work.

Options worth knowing: `--from <ref>` to branch from something other than the
default, `--no-up` to create it without starting anything, `--path <dir>` to
choose the location.

## Running things

`wt run <cmd…>` injects the worktree's environment and passes the child's exit
code straight through.

    wt run pnpm test:e2e
    wt run pnpm db:seed

Injected: `BASE_URL`, `API_URL`, `WT_URL_<SERVICE>`, `WT_HOST_<SERVICE>`,
`WT_PORT_<SERVICE>`, `WT_NAME`, `WT_BRANCH`, plus anything under `[env]` in
worktree.toml (typically `DATABASE_URL`).

Never hardcode a URL or a port. Read them from the manifest or the environment.

Flags before the command are `wt`'s; from the first bare word onward everything
belongs to the child. `wt run --json node script.js` vs
`wt run node script.js --json`.

## Starting only what you need

Full stacks are expensive and several worktrees may be running at once. Start the
minimum:

    wt up --group backend     # a named set from worktree.toml
    wt up api                 # api plus its dependencies
    wt up api --no-deps       # exactly api

## Cleaning up

`wt down` stops containers and keeps volumes, data and port leases. It is safe
and reversible — do it freely when a stack is no longer needed. `wt up` brings it
back in seconds.

`wt rm <slug>` is the destructive one: it deletes the worktree, its containers
and its database. It refuses to run on a worktree with uncommitted changes, and
on the one you are standing in. Add `--delete-branch` to drop the branch too.
**Ask before running it.**

`wt gc --dry-run` shows what has been orphaned; `wt gc` reclaims it. It only ever
deletes things it can prove are dead — a container whose worktree it has no
record of is reported and left alone.

`wt ls --json` shows every worktree and whether its stack is running.

## Diagnosing

`wt doctor` checks the environment and the migration: Docker and Compose
versions, whether the compose files merge, whether any service still publishes a
host port, whether wildcard DNS resolves to loopback, and whether the proxy can
read the Docker socket. Run it first when something is inexplicably unreachable.

If a fresh worktree is missing config or dependencies, `wt hydrate` re-copies
them from the main worktree.
