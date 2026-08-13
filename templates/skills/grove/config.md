# Writing worktree.toml from discovery findings

Reference for the synthesis step of `/setup-grove`. The discovery agents
returned findings across six axes; this turns them into one config.

**One author.** Findings arrive in parallel; the config is written by a single
pass over all of them. Every collision below is invisible to an agent holding
only one service - which is exactly why synthesis is not fanned out.

## Merge first, then look for the four collisions

Reconcile service names across axes, then check the merged set. Each of these
produces a config that boots one worktree and fails the second.

**Two services reading one key.** Group findings by `key`. A key appearing under
more than one `service` hands both the same value. Real cases: MSBuild
`SpaProxyServerUrl` reaching every project in the build; two Vite apps both
reading `DEV_SERVER_PORT`; a shared `PORT` in one `.env`.
Fix: a distinct key per service (`PORTAL_UI_PORT`, `ADMIN_UI_PORT`), which is a
source change - so it is a blocker unless the key is already per-service.

**A reference pointing at a port that moves.** Every `kind: "reference"` finding
whose target service is getting a lease must be parameterised too, or it keeps
dialling the old number. This is the one that survives a green boot and fails
under real use.

**A bind site the orchestrator thinks it owns.** Axis 5 says the parent assigns
a port; axis 2 says the child binds its own key. The child wins. Route the lease
to the child's key.

**A build-time value set at runtime.** Any `movable: "build"` finding wired
through `[env]` does nothing, silently. It needs build-time injection, or a
runtime indirection the app reads instead.

## Blockers stop the run

Collect every finding with `movable: "no"`, plus every collision above that
needs a source change. If the list is non-empty, **stop and ask before writing
source** - see the blocker gate in [`verify.md`](verify.md).

Write `worktree.toml` first regardless, with those services present as
reservations and a comment saying what they still bind. A reservation costs
nothing and records that the port was accounted for.

## The two ways a lease gets back to a process

| Finding | Mechanism |
|---|---|
| `how: "config_key"` - read from a file at startup | `[render]` writes the file |
| `how: "env"` / `"cli_flag"` | `[env]` supplies the variable |
| `how: "derived"` - a parent computes it | whichever the parent reads |

`[render]` when the app already reads a config file - prefer an existing
optional file the app loads *after* its committed defaults, so the rendered
values win without editing anything tracked.

## Shape

```toml
[project]
name = "<repo>"
compose = []                 # or the compose files, if some of it is containerised

[[services]]
name = "server"              # one entry per process you start
layer = "backend"
runtime = "host"
start = "<the command a developer runs today>"
health = { tcp = true }

[[services]]
name = "api-grpc"            # no `start`: a port reservation for something the
layer = "backend"            # process above opens itself
runtime = "host"
health = { tcp = true }

[render]
"config/ports.generated.json" = """
{ "ports": { "apiGrpc": ${WT_PORT_API_GRPC} } }
"""

[env]
SERVER_URL = "https://localhost:${WT_PORT_SERVER}"

[hydrate]
copy = [".env"]
link = ["node_modules"]
run  = ["npm ci"]
```

Rules:

- **One `start` per *process*, not per port.** An orchestrator launching five
  services is one entry with `start`; the other four are reservations.
- A service's variable is `WT_PORT_` + its name uppercased, non-alphanumerics as
  `_`. `api-grpc` -> `WT_PORT_API_GRPC`.
- Every rendered file must be gitignored. Committed, it hands every worktree the
  same ports - `grove doctor` checks this.
- `[hydrate]`: `link` a `node_modules`-shaped directory, `copy` a `.env`, `run`
  the install command.

## Comments carry what the next person needs

For every service, say **which key moves it**, and for anything unresolved, what
it still binds and the smallest change that would fix it. Record the finding
even when the reservation turns out to be ignored - a reservation costs nothing,
and the next person needs to know it was tried.

State observed facts as observed, and inferences as inferences. A comment
claiming a port is honoured, written before the audit ran, is worse than no
comment: it is checked once, believed, and never re-read.

## After changing this file

`grove down` before `grove up`. `grove up` restarts a process whose *rendered*
config changed, but a change affecting only `[env]` is invisible to it, and a
process started earlier still holds the old values.
