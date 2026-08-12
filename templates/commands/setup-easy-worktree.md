---
description: Migrate this repo so every git worktree runs its own isolated stack
---

Set this repository up for `wt` (easy-worktree). **You are doing this, not the
user** — they run this command and read your summary at the end. The only thing
they should have to do by hand is answer a question you cannot answer from the
code.

Work through the steps in order and stop at the first one that fails — a later
step assumes the earlier one held.

## 0. Which shape is this repo?

```
wt adapt evidence --json
```

Read `containerised` in the output.

- **`true`** — there is a compose file. Continue at step 1; `wt adapt` does most
  of the work and your judgment is needed only for the decisions file.
- **`false`** — nothing here is containerised. **Skip to "Repos with no
  containers"** at the bottom. `adapt decide` and `adapt render` have nothing to
  read, and you write `worktree.toml` yourself.

A repo can be both — containerised services plus processes run on the host. Do
steps 1–4 for the compose part, then add `runtime = "host"` entries for the rest.

## 1. Gather evidence (no guessing)

Step 0 already produced it. It ran `docker compose config --format json`, so
anchors, `extends`, `include`, profiles and `env_file` are already resolved.
**Never read the compose YAML with a regex** — read this output.

For each service it reports: image, build context, published ports, `expose`,
environment, depends_on, an existing healthcheck, and a `guess` from the
known-image table. The guess is a fast path, not a decision.

## 2. Decide

Write `.wt/decisions.json`. This is the only step that needs judgment, and it is
a **file**, not a command — so it is reviewable and re-runnable.

Start from the heuristic and correct it:

```
wt adapt decide --heuristic --json
```

For every service decide:

- **`kind`** — `http` (something a browser or another service talks to over HTTP)
  or `tcp` (a database, a queue, a cache) or `worker` (talks to nobody).
- **`layer`** — `frontend` / `backend` / `worker` / `data` / `infra`.
- **`subdomain`** — only for `http`. This is what the URL becomes.
- **`hostPort`** — only for `tcp` services the developer needs to reach from the
  host (a database they open in a GUI client). Rule of thumb: if the base compose
  file published a port, the author wanted to reach that thing — keep it
  reachable, on a leased port. If they did not publish it, leave it internal.
- **`health`** — a path for `http`, or an exec command such as
  `["pg_isready", "-U", "app"]`.

Every entry needs `evidence` (what in the compose file told you) and
`confidence`. Anything you are unsure about: set `confidence: "low"` and say why
— it lands on a review list instead of being silently applied.

Two things worth getting right:

- **Browser-facing env vars are the only ones that change per worktree.**
  `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` are read by a browser, which is not on
  the Docker network, so they must use the external hostname. Everything else —
  `DATABASE_URL`, server-to-server calls — stays on service names and is
  byte-identical in every worktree.
- **`NEXT_PUBLIC_*` and friends are baked at build time.** Setting them under
  `environment:` does nothing for the browser bundle. They belong in
  `build.args`, or the app serves a runtime `/env.js`.

## 3. Render

```
wt adapt render --json
```

Deterministic code, no model: it turns the decisions into
`docker-compose.worktree.yml` and `worktree.toml`. The base compose file is never
modified — the overlay is a new file, so a bad generation is one `rm` away.

Read both files and check the two mechanical traps:

- `ports: !reset []` cancels published ports. `!reset` **erases and ignores any
  value you give it** — `ports: !reset ["${WT_PORT_DB}:5432"]` publishes nothing.
  Use `!override` whenever you mean "replace with this".
- Every service needs a `<name>.internal` network alias. Siblings must call each
  other through it, because a bare `api` is ambiguous on the shared proxy network
  where every worktree has one.

## 4. Validate

```
wt adapt validate --json
```

Merges the files, boots the stack and requests every URL it generated. Then:

```
wt doctor --json
wt up --build
wt status --json
```

If a service never becomes healthy, the manifest names it and carries its logs.
Fix the overlay, not the test.

## 5. Report

Tell the user, briefly:

- which services got public URLs, and what they are
- which kept a host port, and why
- anything with `confidence: "low"` that they should check
- the one-line commands they now have: `wt new <branch>`, `wt up`, `wt run <cmd>`

---

# Repos with no containers

Nothing is containerised, so there is no proxy, no hostnames, and no compose file
to read. Every service is `runtime = "host"`: `wt` leases a distinct port per
worktree and hands it back. **You write `worktree.toml`** — `adapt` cannot,
because the ports live in code rather than in a machine-readable file.

## A. Find every hardcoded port

This is the whole job, and it is a reading task. Search for port literals in:

- launch/run profiles (`launchSettings.json`, `.vscode/launch.json`, `Procfile`)
- `.env*` files and any config the app reads at startup
- dev-server config (`vite.config.*`, `next.config.*`, `webpack.config.*`)
- the startup path itself — `listen(`, `--port`, `PORT =`, `:8080`
- any orchestrator that starts other processes, which usually pins several

For each one, record: what it is, which port, and **how it is configured** —
because that determines how `wt` hands the new port back. There are two ways, and
you will usually need both:

- **read from a file at startup** → a `[render]` template writes it
- **read from an environment variable** → an `[env]` entry supplies it

A port that is a literal in code with no override is a blocker. Say so in your
report and suggest the smallest change that makes it configurable, in the style
the surrounding code already uses. **Do not make that change without asking.**

## B. Write worktree.toml

```toml
[project]
name = "<repo>"
compose = []                 # nothing containerised

[[services]]
name = "server"              # the thing you start; one entry per process
layer = "backend"
runtime = "host"
start = "<the command a developer runs today>"
health = { tcp = true }

[[services]]
name = "api-grpc"            # no `start`: reserve a port for something the
layer = "backend"            # above process opens itself
runtime = "host"
health = { tcp = true }

[render]
"<config file the app reads>" = """
{ "ports": { "apiGrpc": ${WT_PORT_API_GRPC} } }
"""

[env]
SERVER_URL = "https://localhost:${WT_PORT_SERVER}"
```

Rules that matter:

- **One `start` per *process*, not per port.** An orchestrator that launches five
  services is one entry with `start`; the other four are port reservations.
- The env var name for a service is `WT_PORT_` + its name uppercased, with
  non-alphanumerics as `_`. `api-grpc` → `WT_PORT_API_GRPC`.
- Every rendered file must be gitignored. Committed, it hands every worktree the
  same ports — `wt doctor` checks this.
- `[hydrate]` for what git will not bring: `link` a `node_modules`-shaped
  directory, `copy` a `.env`, `run` the install command.

### Traps that have already cost a session

**A dev server's proxy target is a separate port from the dev server itself.**
A frontend usually proxies `/api` to the backend, and reads that target from its
own variable. Move the backend's port without moving the proxy target and the
UI loads but every call through it fails — which looks like a broken app, not a
config gap. Check every dev-server config for where it points, not just what it
binds.

**A build-tool variable can hit more than one project.** MSBuild reads
environment variables as properties, so a generic name like `SpaProxyServerUrl`
reaches every project at once and gives them all the same value. Where two
services read the same variable name, introduce a distinct one per service
rather than setting the shared one.

**A service may ignore the port its orchestrator assigns it.** Anything calling
`listen()` / `UseUrls()` / `ConfigureKestrel()` with its own config value binds
that value regardless of what it was handed. Those need the leased port routed
to *their* key, via `[env]`.

**Not everything you reserve will be honoured.** If a variable turns out to be
ignored, say so in the config rather than deleting the entry — a reservation
costs nothing, and the next person needs to know it was tried.

## C. Verify, and expect the environment to fight you

```
wt doctor            # config valid, generated files ignored
wt up                # renders, starts, waits
wt status            # every service and the port it is on
```

Then check the process **actually took the leased port** — do not assume it did:

```
wt logs <service>    # what did it say it was listening on?
```

If `wt status --env` shows a leased port but the process came up on its old one,
the launcher is overriding the environment. Many run commands apply their own
profile's variables *over* the ambient ones. Look for a flag that skips the
profile, and then supply whatever that profile was setting via `[env]`.

**After changing worktree.toml, `wt down` before `wt up`.** `wt up` restarts a
host process whose *rendered* config changed, but a change that only affects
`[env]` is invisible to it — and a process started earlier is still holding the
old values.

Then prove the point:

```
git add worktree.toml .gitignore && git commit    # required: see below
wt new feat/scratch
```

**Commit worktree.toml first.** A new worktree gets the branch's files, so an
uncommitted config means the worktree arrives without one and `wt new` rolls
back. If you branched from somewhere that lacks it, `--from <your-branch>`.

Confirm both worktrees are up on disjoint ports, and that they *serve* rather
than merely listen — request a real endpoint on each. Then `wt rm feat-scratch`.

## D. Report

- every port now leased, and what reads it
- anything still hardcoded that you could not make configurable, and the change
  you would suggest
- whether two worktrees actually ran simultaneously, or why not
