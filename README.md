# git-grove

Every git worktree gets its own fully-deployed, independently addressable stack —
no port juggling, no config rewriting, and a machine-readable manifest so an agent
can find it and test against it.

```bash
grove new feat/login      # branch + worktree + hydrate + boot, one call
grove run pnpm test:e2e   # BASE_URL/API_URL/DATABASE_URL injected, exit code passed through
grove rm feat-login       # worktree, containers, volumes, leases, all of it
```

## How it works

Ports only collide *on the host*. A Docker network is a separate address space, so
two worktrees can both run `web:3000` and `db:5432` and never meet. Compose already
gives you one network per project name; what it doesn't give you is a way back in.
That's the proxy's job.

```
HOST — one published port on the whole machine
┌──────────────────────────────────────────────┐
│  :80  traefik                                │
└───┬──────────────────────────┬───────────────┘
    │ Host: web.feat-a…        │ Host: web.fix-b…
┌───▼───────────────┐   ┌──────▼────────────┐
│ net: feat-a       │   │ net: fix-b        │
│   web  :3000      │   │   web  :3000      │  ← identical. fine.
│   api  :4000      │   │   api  :4000      │
│   db   :5432      │   │   db   :5432      │
└───────────────────┘   └───────────────────┘
```

The hostname is the routing key, so no port ever appears in a URL. Everything
inside the stack — `DATABASE_URL`, `API_URL` — is byte-identical in every worktree.
Only browser-facing URLs vary, and they come from `${WT_NAME}`.

## Install

```bash
npm install -g git-grove
cd your-repo
grove install     # agent skill, slash command, hooks, .gitignore entry
grove adapt evidence && grove adapt decide --heuristic && grove adapt render
grove doctor && grove up
```

`grove adapt` generates the two files below. You can also write them by hand — see
[`examples/sample-app`](examples/sample-app) for a complete working pair.

## Commands

| | |
|---|---|
| `grove new <branch>` | branch, worktree, hydrate, start — one call |
| `grove up [services…]` | start and block until healthy; idempotent |
| `grove down [services…]` | stop, keeping volumes, data and leases |
| `grove restart [services…]` | stop and start again — only what you name |
| `grove rm <worktree>` | delete the worktree and everything it owns |
| `grove gc` | reclaim containers, volumes and leases nothing owns |
| `grove run <cmd…>` | run with this worktree's env injected |
| `grove status` / `grove ls` | this worktree / this repo's worktrees |
| `grove ls --all` | every worktree on the machine, with its ports |
| `grove logs [services…]` | container logs |
| `grove hydrate` | re-copy gitignored files from the main worktree |
| `grove adapt <step>` | migrate a repo: evidence → decide → render → validate |
| `grove install` | wire up the agent skill, slash command and hooks |
| `grove doctor` | check the environment and the migration |

Every command takes `--json`. Human output can change freely; **`--json` is a
contract**.

## Setup

Two files next to your compose file. `docker-compose.yml` is never modified.

**`docker-compose.worktree.yml`** — an overlay, applied with `-f base -f overlay`:

```yaml
services:
  api:
    ports: !reset []                     # cancel the base file's published ports
    networks:
      internal: { aliases: [api.internal] }
      wt-proxy: {}
    labels:
      - traefik.enable=true
      - traefik.http.routers.${WT_NAME}-api.rule=Host(`api.${WT_NAME}.${WT_DOMAIN}`)
      - traefik.http.services.${WT_NAME}-api.loadbalancer.server.port=4000

  db:
    ports: !override ["${WT_PORT_DB}:5432"]   # leased host port, see gotcha below
    networks: [internal]

networks:
  internal:
  wt-proxy:
    external: true
    name: ${WT_PROXY_NETWORK}
```

**`worktree.toml`** — what each service is, and how to tell it's up:

```toml
[project]
name = "sample-app"
compose = ["docker-compose.yml", "docker-compose.worktree.yml"]

[[services]]
name = "api"
layer = "backend"
subdomain = "api"          # becomes api.<worktree>.localtest.me
port = 4000
health = "/healthz"

[[services]]
name = "db"
layer = "data"
host_port = true           # leased, so you can open it in a GUI client
health = { exec = ["pg_isready", "-U", "app"] }

[groups]
backend = ["api", "db"]    # grove up --group backend

[env]
DATABASE_URL = "postgres://app:app@${WT_HOST_DB}/app"

# Gitignored files git will not bring to a new worktree.
[hydrate]
copy = [".env", "apps/*/.env.local"]
link = ["node_modules", "apps/*/node_modules"]
run  = ["pnpm install --frozen-lockfile"]
```

Copy what you may edit per worktree; link what is large and identical. `grove` decides
between `link` and `run` by hashing the lockfiles: identical means sharing one
`node_modules` is safe, different means the branch changed its dependencies and it
installs instead.

## Stacks Docker doesn't run

Not every repo is containerised. An orchestrator that launches its own child
processes, a compiled server, a dev server you start yourself — these bind host
ports directly, so there's no Docker network to hide identical ports inside and
the proxy has nothing to route to. What still collides is the port, and that
part `grove` can own:

```toml
[project]
name = "my-app"
compose = []               # nothing containerised at all — that's allowed

[[services]]
name = "server"
runtime = "host"           # not a container
start = "./scripts/dev-server"
health = { tcp = true }

[[services]]
name = "api-grpc"
runtime = "host"           # no `start` — just reserve the port
health = { tcp = true }

# Hand the leases back through a file the app already reads.
[render]
"config/ports.generated.json" = """
{ "ports": { "apiGrpc": ${WT_PORT_API_GRPC} } }
"""

# …or through the environment, for anything read from there.
[env]
SERVER_URL = "https://localhost:${WT_PORT_SERVER}"
```

`grove up` then renders the config, starts the process with that environment,
records its pid and waits for it to answer — the same contract a container gets.
`grove down` stops it and everything it spawned, `grove logs server` shows its output.
So `grove new feat/x` ends with a **running** stack, and two worktrees run at once.

A service with no `start` is a port reservation this tool observes but doesn't
own: never `unhealthy`, never blocking the stack from `ready`, shown as
`listening` or `not running`. Only what `grove` launches is what `grove` reports on.

Rendered files are rewritten only when their content changes — those paths are
what a hot-reloading dev server watches — and `grove doctor` checks they're
gitignored, since committed they'd hand every worktree the same ports.

**Watch for launcher wrappers that override the environment.** Some run commands
apply their own profile's variables *over* the ambient environment, so what `grove`
injects is silently ignored and the process comes up on its hardcoded port. If a
leased port shows in `grove status --env` but the process ignores it, that is
usually why — look for a flag that skips the profile.

## Gotchas this repo learned the hard way

All of these were found by running it, not by reading docs.

**On Windows, `grove` is Windows Terminal.** It ships as an app execution alias on
every user's PATH, so whether `grove` means this tool comes down to PATH order —
and when it loses, `grove up` opens a terminal window. The package installs as
`ewt` too; prefer that on Windows. `grove doctor` reports which one is live, and
`grove install` verifies the binary it writes into a hook is actually this package.

**`!reset` erases, `!override` replaces.** `ports: !reset ["8080:80"]` silently
publishes *nothing* — the value is ignored. Use `!override` whenever you mean
"replace with this". `grove doctor` checks for it.

**Traefik must be ≥ 3.6 on Docker Engine 29+.** Earlier 3.x negotiates a Docker API
version below 1.44, which Engine 29 rejects. Traefik still starts and still
answers — with 404 for everything, and only its container logs say why. `grove doctor`
checks this too.

**Every service on the shared network needs a `<name>.internal` alias.** A bare
`api` is ambiguous there, because every worktree has one. It works with a single
worktree and goes wrong with two. `grove adapt validate` checks for it.

**A socket probe cannot predict whether Docker can publish a port.** On Windows a
port can be reserved such that `docker run -p` fails while a plain `listen` on
`0.0.0.0` succeeds. Docker is the authority; the pre-check is advisory.

**Docker Desktop on Windows often holds `:80`** with no containers running. Set
`[proxy] port` — URLs then include the port, which works fine.

**Never commit `.wt/`.** A committed `state.json` makes a new worktree inherit
another worktree's slug and drive its containers. The tool discards state whose
recorded `root` doesn't match, but the `.gitignore` entry is the real fix — and
`grove install` writes it for you.

**`*.localhost` does not resolve via the Windows resolver.** Chrome handles it
internally, but `curl`, Node `fetch` and Playwright's request context do not.
Default the domain to `localtest.me`.

**`NEXT_PUBLIC_*` / `VITE_*` are baked at build time.** Setting them under
`environment:` does nothing for the browser bundle — pass them as `build.args`, or
serve a runtime `/env.js`.

## The manifest

`.wt/manifest.json`, inside the worktree so a relative read always resolves.
Written on success *and* on failure, with logs attached, so a consumer learns which
layer broke and why.

```json
{
  "schemaVersion": 1,
  "worktree": "fix-billing",
  "status": "ready",
  "scope": ["api", "db"],
  "baseUrl": "http://web.fix-billing.localtest.me:8081",
  "services": [
    { "name": "api", "status": "ready", "url": "…", "internalUrl": "http://api.internal:4000" },
    { "name": "db",  "status": "ready", "hostAddress": "localhost:23229" },
    { "name": "web", "status": "not-started" }
  ]
}
```

`status: ready` means everything in `scope` is ready. `not-started` means the
service was never asked for — it is not a failure, and consumers must not try to
repair it. That distinction is the whole reason partial startup is safe.

## Agent integration

`grove install` writes:

- `.claude/skills/git-grove/SKILL.md` — the daily-use skill
- `.claude/commands/setup-git-grove.md` — a `/setup-git-grove` command that
  drives the migration
- `SessionStart` / `SessionEnd` hook entries in `.claude/settings.json`, merged
  rather than overwritten
- `.wt/` in `.gitignore`, and an `AGENTS.md` section if that file exists

Hooks call `grove hook <event>`, resolved at install time to a global `grove` or to
`npx --no-install git-grove` — a hook pointing at a binary that isn't on PATH
fails silently, which is worse than not installing it.

`SessionStart` reports the worktree and what to run. `SessionEnd` does nothing
unless you set `[hooks] on_session_end = "down"`: that hook has no turn to render a
question into, so only reversible actions belong there.

## Development

```bash
npm install
npm run typecheck
npm test                       # unit + git-backed integration, no Docker needed
WT_TEST_DOCKER=1 npm test      # adds the full boot-a-real-stack suite
npm run build
```

Docker tests each use their own branch, and therefore their own Compose project,
containers and port leases — they will not touch a stack you have running.

## License

MIT
