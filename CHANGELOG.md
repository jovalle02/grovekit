# Changelog

## 0.2.0

The lifecycle release: a worktree can now be created, hydrated, used and deleted
without leaving anything behind.

### Added

- **`wt new <branch>`** — branch, `git worktree add`, hydrate, start, wait until
  healthy, in one call. Rolls the worktree back if setup fails, so a failed run
  never leaves a directory holding the branch checked out.
- **Hydration** (`[hydrate]` in worktree.toml, and `wt hydrate`) — copies the
  gitignored files a fresh worktree cannot get from git. `link` vs `run` is
  decided by hashing lockfiles: identical means one `node_modules` can safely be
  shared, different means the branch changed its dependencies and it installs.
  Directory links are Windows junctions, which need no elevation.
- **`wt rm <worktree>`** — removes the worktree, its containers, its volumes, its
  port leases and its registry entry. Refuses on uncommitted changes, on the main
  worktree, and on the worktree you are standing in.
- **`wt gc`** — reclaims orphans. Deletes only what it can *prove* is dead: a
  slug with a registry entry or a port lease whose worktree is gone. A container
  it has no record of is reported and left alone, so a lost registry file can
  never turn cleanup into destruction. `--dry-run` shows the plan; `--proxy` also
  stops the shared proxy when nothing is left to route to.
- **Registry** at `~/.easy-worktree/registry.json`, populated by every command,
  so worktrees created by hand are known too.
- **`wt adapt`** — the migration pass, as `evidence` → `decide` → `render` →
  `validate`. Reads `docker compose config --format json` rather than the YAML,
  emits a new overlay file rather than editing the base one, and renders
  deterministically from a reviewable `.wt/decisions.json`. `decide --heuristic`
  needs no model; the interactive path replaces only that step.
- **`wt install`** — writes the agent skill, the `/setup-easy-worktree` command,
  merged `SessionStart`/`SessionEnd` hook entries, and the `.wt/` gitignore rule.
  The hook command is resolved at install time, because a hook pointing at a
  binary not on PATH fails silently.
- **`wt hook session-start|session-end`** — logic in the tool rather than inline
  shell, so it is cross-platform and versioned. `session-end` does nothing unless
  `[hooks] on_session_end = "down"`; that hook has no turn to ask a question in,
  so only reversible actions belong there.
- **Test suite** — 153 tests covering slugs, quoting, scope logic, config
  validation, leases, the registry, hydration, the adapt renderer (byte-compared
  against a fixture) and the whole CLI through real processes. A Docker-backed
  suite behind `WT_TEST_DOCKER=1` boots real stacks, runs two worktrees at once
  and asserts the crash path.

### Fixed

- **`wt up` exited 0 for a stack with a crashed service.** A service that dies
  before the first `compose ps` was reported `stopped` rather than `starting`, so
  it was never probed, never marked unhealthy and never had its logs attached —
  apparent success for a broken stack. Found by the new Docker suite.
- `wt logs --json` reported `services: []` for a whole-stack query, which reads
  as "none" rather than "all".
- `wt doctor` now suggests a proxy port that Docker has been asked to publish and
  accepted, instead of one a socket probe merely found free.

Three more bugs were caught before they shipped and are recorded as traps 11–13
in `HANDOFF.md`: a `gc` sweep that would have destroyed every stack on a machine
with a lost registry file, a shared mutable empty-registry constant, and a
`startsWith` path check that confused `app-feature` with `app-feat`.

## 0.1.0

`up` / `down` / `run` / `status` / `logs` / `ls` / `doctor`, the shared Traefik
proxy, port leases, and the `.wt/manifest.json` contract.
