# Changelog

## 0.5.0

### Added

- **`grove new --seed-from <worktree>`** copies database contents into the new
  worktree before the application starts.

  A new worktree gets an empty database. That is correct when the data is
  rebuilt from the repo on boot, and useless when it got there by restoring a
  dump - which is the reason teams abandon isolation and go back to one shared
  database, where a migration on one branch breaks everyone else's.

  A dump in one container piped straight into a restore in the other; nothing
  lands on disk in between, so a database larger than the free space on the
  machine still copies. Postgres, MySQL/MariaDB and Mongo are recognised by
  image, and the credentials are read from the running container rather than
  re-derived from the compose file, because `env_file`, `extends` and shell
  interpolation have already been resolved there.

  The two databases stay separate afterwards. Only the starting point is shared.

- `[seed] from = "<worktree>"` in `worktree.toml`, to make that the default for
  every `grove new`, and `--no-seed` to override it.

- Interactively, `grove new` measures the source and offers the copy with the
  size attached - the transfer dominates how long the command takes, and that is
  the fact needed to answer. An agent is never prompted: `--json` without
  `--seed-from` does not copy, because a question nobody is reading is a hang.

## 0.4.0

Renamed, and made legible from outside a single worktree.

### Changed

- **The tool is `grovekit`; the command is `grove`.** The old name was taken on
  npm and promised rather than described. A grove is a stand of trees growing
  together, which is the product. One binary, deliberately: every alias is
  another thing that can be shadowed, another string baked into someone's hook
  file, and another way for two installs to disagree - which this project paid
  for once already when `wt` turned out to be Windows Terminal on every Windows
  PATH.
- On-disk identifiers are **not** renamed: `.wt/`, the `WT_*` variables user
  configs interpolate, `~/.easy-worktree/`, the proxy project and the
  `wt.managed` label all have live data behind them.

### Added

- **`grove ls --all`** - every worktree on the machine, across repositories, with
  its leased ports. The per-repo listing structurally cannot answer "what else is
  running?", because it enumerates from one repo's git worktree list.
- **`grove restart [services...]`** - the verb whose absence was being worked
  around by taking the whole stack down and back up.
- **`SessionStart` now names this worktree's own addresses**, service by service,
  and the other worktrees that are live with theirs. A port carried over from
  another worktree fails in a way that looks like a broken application rather
  than a wrong address.
- **Unknown config keys are rejected.** A `[hydrate]` written in the wrong shape
  parsed fine, produced empty lists, passed `doctor` and was reported as working
  - while nothing was copied and nothing linked.

### Fixed

- **The TCP probe only tried IPv4**, so a dev server bound to `::1` reported "not
  running" while serving correctly - and the workaround was deleting its health
  check.
- **`grove up` did not restart a process whose generated config had changed**, so
  editing `worktree.toml` and re-running it kept the old ports: the change looked
  applied and was not.
- **`install` left the previous name's hook and skill in place**, so the session
  context was injected twice and two competing skills fought for selection.
- `grove new` now explains that an uncommitted `worktree.toml` is why the new
  worktree lacked one, and `grove rm` names `core.longpaths` as the usual cause of
  git's bare exit 255 on Windows.

## 0.3.0

Stacks that Docker does not run. Built against a real non-containerised
repository, which is where every fix below came from.

### Added

- **`runtime = "host"` services.** A service Docker does not run - an
  orchestrator that launches its own children, a compiled server, a dev server.
  The proxy trick needs a Docker network to hide identical ports inside and a
  host process has none, so what `grove` owns instead is the port: one lease per
  worktree.
- **`start` on a host service.** `grove up` renders the config, launches the process
  with the worktree's environment, records its pid and waits for it to answer -
  the same contract a container gets. `grove down` stops it and everything it
  spawned, `grove logs` shows its captured output, `grove rm` stops it before deleting
  the directory. So `grove new` ends with a *running* stack rather than instructions
  for starting one.

  Making that work on Windows needed a supervisor process, because the two
  necessary properties are mutually exclusive in a single spawn - measured, not
  assumed: an attached child's output is captured but it dies when `grove` exits; a
  detached one survives but has no console, so its output goes nowhere. `grove`
  detaches a small `node -e` supervisor, which opens the log and runs the real
  command as an ordinary attached child.

  A service with no `start` stays a port reservation this tool observes but does
  not own: never `unhealthy`, never blocking `ready`. Reporting a failure for a
  process the developer simply has not launched would make `grove up` hang.
- **`[render]`** - files written from the worktree's environment on `grove up` and
  `grove status`. The other half of the above: a leased port is useless until the
  process that needs it can discover what it got, and these stacks already read a
  local config file. An unchanged file is not rewritten, mtime included, because
  those paths are what a hot-reloading dev server watches. A missing variable
  fails the file rather than expanding to nothing and producing config that
  parses wrong somewhere else.
- **Repos with nothing containerised.** `project.compose` may be empty when every
  service is `host`. `grove up` then starts no proxy, and `grove doctor` omits the
  compose, DNS and proxy checks rather than reporting them green.
- A `doctor` check reporting which binary on PATH is actually this package.

### Fixed

- **`grove install` wrote a hook pointing at Windows Terminal.** `which("grove")`
  returned true because Windows ships `grove.exe` as an app execution alias on every
  user's PATH; the hook written on the strength of it would have opened a
  terminal window at the start of every session, silently. Resolution now
  verifies that the file a name resolves to is actually this package.
- **`grove new` branched from `main` instead of HEAD.** Found by using it: the
  config enabling this tool was on a feature branch, so the new worktree had no
  `worktree.toml` and the whole command rolled back, reporting a missing file
  that was sitting on the branch the user was standing on. HEAD is what
  `git switch -c` uses.
- **`grove new`'s rollback left the branch behind.** The obvious retry then did
  something different and worse - checking the branch out instead of creating it,
  inheriting the failed run's base, and reporting an error about the consequence.
- **A crashed host service reported `ready`.** A TCP probe cannot tell "my
  process is up" from "somebody else is on that port", and leases are
  deterministic - the port a worktree gets is exactly the one an orphan of its
  own last run is holding. The pid is now the authority and the open port only
  corroborates, and `grove up` refuses to start onto a port already answering,
  naming the likely orphan and how to find it.
- **Line endings.** `git checkout` on Windows rewrote `test/fixtures/` as CRLF and
  the byte-comparison tests failed on a clean checkout of a commit whose tests
  had just passed. `.gitattributes` now pins LF, which is also the only way the
  three-OS CI matrix produces identical working trees.

## 0.2.0

The lifecycle release: a worktree can now be created, hydrated, used and deleted
without leaving anything behind.

### Added

- **`grove new <branch>`** - branch, `git worktree add`, hydrate, start, wait until
  healthy, in one call. Rolls the worktree back if setup fails, so a failed run
  never leaves a directory holding the branch checked out.
- **Hydration** (`[hydrate]` in worktree.toml, and `grove hydrate`) - copies the
  gitignored files a fresh worktree cannot get from git. `link` vs `run` is
  decided by hashing lockfiles: identical means one `node_modules` can safely be
  shared, different means the branch changed its dependencies and it installs.
  Directory links are Windows junctions, which need no elevation.
- **`grove rm <worktree>`** - removes the worktree, its containers, its volumes, its
  port leases and its registry entry. Refuses on uncommitted changes, on the main
  worktree, and on the worktree you are standing in.
- **`grove gc`** - reclaims orphans. Deletes only what it can *prove* is dead: a
  slug with a registry entry or a port lease whose worktree is gone. A container
  it has no record of is reported and left alone, so a lost registry file can
  never turn cleanup into destruction. `--dry-run` shows the plan; `--proxy` also
  stops the shared proxy when nothing is left to route to.
- **Registry** at `~/.easy-worktree/registry.json`, populated by every command,
  so worktrees created by hand are known too.
- **`grove adapt`** - the migration pass, as `evidence` -> `decide` -> `render` ->
  `validate`. Reads `docker compose config --format json` rather than the YAML,
  emits a new overlay file rather than editing the base one, and renders
  deterministically from a reviewable `.wt/decisions.json`. `decide --heuristic`
  needs no model; the interactive path replaces only that step.
- **`grove install`** - writes the agent skill, the `/setup-grove` command,
  merged `SessionStart`/`SessionEnd` hook entries, and the `.wt/` gitignore rule.
  The hook command is resolved at install time, because a hook pointing at a
  binary not on PATH fails silently.
- **`grove hook session-start|session-end`** - logic in the tool rather than inline
  shell, so it is cross-platform and versioned. `session-end` does nothing unless
  `[hooks] on_session_end = "down"`; that hook has no turn to ask a question in,
  so only reversible actions belong there.
- **Test suite** - 153 tests covering slugs, quoting, scope logic, config
  validation, leases, the registry, hydration, the adapt renderer (byte-compared
  against a fixture) and the whole CLI through real processes. A Docker-backed
  suite behind `WT_TEST_DOCKER=1` boots real stacks, runs two worktrees at once
  and asserts the crash path.

### Fixed

- **`grove up` exited 0 for a stack with a crashed service.** A service that dies
  before the first `compose ps` was reported `stopped` rather than `starting`, so
  it was never probed, never marked unhealthy and never had its logs attached -
  apparent success for a broken stack. Found by the new Docker suite.
- `grove logs --json` reported `services: []` for a whole-stack query, which reads
  as "none" rather than "all".
- `grove doctor` now suggests a proxy port that Docker has been asked to publish and
  accepted, instead of one a socket probe merely found free.

Three more bugs were caught before they shipped and are recorded as traps 11-13
in `DESIGN.md`: a `gc` sweep that would have destroyed every stack on a machine
with a lost registry file, a shared mutable empty-registry constant, and a
`startsWith` path check that confused `app-feature` with `app-feat`.

## 0.1.0

`up` / `down` / `run` / `status` / `logs` / `ls` / `doctor`, the shared Traefik
proxy, port leases, and the `.wt/manifest.json` contract.
