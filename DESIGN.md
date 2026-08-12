# grovekit — design notes

Read this before changing anything load-bearing. It carries the design
rationale, what is built and proven, what is missing, and every trap that has
already cost real debugging time. Written
2026-08-10 at the end of M1; updated the same day at the end of M2.

---

## 1. What we are building

A CLI (`grove`) so that **every git worktree runs its own fully-deployed, independently
addressable copy of a multi-layer stack** — with no port juggling, no per-worktree
config rewriting, and a machine-readable manifest so an AI agent can find the stack
and run e2e tests against it.

The motivating problem: doing end-to-end testing across several worktrees means
deploying every layer of the repo several times, and ports collide.

### The core insight everything follows from

**Ports only collide on the host.** A Docker network is a separate address space,
so two worktrees can both run `web:3000`, `api:4000`, `db:5432` and never meet.
Compose already gives one network per project name (`-p <slug>`); what it does not
give you is a way back in. That is the proxy's only job.

```
HOST — exactly ONE published HTTP port on the whole machine
┌────────────────────────────────────────────────┐
│  :8081  traefik  (shared, one per machine)     │
└───┬────────────────────────────┬───────────────┘
    │ Host: web.feat-a…          │ Host: web.fix-b…
┌───▼────────────────┐   ┌───────▼───────────────┐
│ net: feat-a        │   │ net: fix-b            │
│   web  :3000       │   │   web  :3000          │  ← identical, no conflict
│   api  :4000       │   │   api  :4000          │
│   db   :5432       │   │   db   :5432          │
└────────────────────┘   └───────────────────────┘
```

Consequences that make this worth building:

- `DATABASE_URL=postgres://app:app@db:5432/app` is **byte-identical in every
  worktree**. The real pain was never the collision, it was the port change
  rippling through six env files across three layers.
- OAuth callbacks, CORS allowlists and cookie domains get stable readable URLs.
- `docker compose -p <slug>` namespaces containers, volumes and networks for free,
  so `down -v` is a complete teardown.
- Only **browser-facing** URLs vary per worktree, driven by `${WT_NAME}`.

### The two kinds of URL (do not lose this distinction)

- **Server-to-server** (api→db, SSR→api): stays inside the Docker network, uses
  service names, identical in every worktree. Most config is this.
- **Browser-to-server** (`NEXT_PUBLIC_API_URL`, OAuth callbacks): the browser is not
  in the Docker network, so these must use the external hostname. **These are the
  only things that change per worktree.**

Gotcha for later: `NEXT_PUBLIC_*` / `VITE_*` / `REACT_APP_*` are baked at **build**
time. Setting them in `environment:` does nothing for the browser bundle — pass
them as `build.args` (each worktree builds its own image, which Compose already
tags per project) or serve a runtime `/env.js` that sets `window.__ENV__`.

---

## 2. Where we are: M1 and M2 are built, tested and verified

Roughly 5,000 lines of TypeScript plus
~1,600 lines of tests; ESM, Node ≥ 20.11, one runtime dep: `smol-toml`).

### Commands that work

| Command | Notes |
|---|---|
| `grove new <branch>` | branch + `worktree add` + hydrate + `up`; rolls back on failure |
| `grove up [services…]` | idempotent; leases ports, ensures proxy, blocks until healthy, writes manifest |
| `grove down [services…]` | `stop` by default, `--remove` also removes containers/networks; **never** deletes volumes |
| `grove rm <worktree>` | the destructive one; guards on main / cwd / dirty |
| `grove gc` | orphan sweep; deletes only provably-dead slugs (see §4.11) |
| `grove run <cmd…>` | injects env, passes child exit code through, refuses if stack not ready |
| `grove status` | read-only; `--json`, `--env` |
| `grove logs [services…]` | `--tail`, `--follow`, `--json` |
| `grove ls` | enumerates worktrees from `git worktree list`, reads each manifest |
| `grove hydrate` | re-runs hydration on an existing worktree |
| `grove adapt <step>` | `evidence` → `decide` → `render` → `validate` |
| `grove install` | skill, slash command, hooks, `.gitignore` |
| `grove hook <event>` | `session-start` / `session-end` |
| `grove doctor` | 9 environment + migration checks |

Flags: `--json` (a contract), `--build`, `--no-deps`, `--timeout <sec>`,
`--remove`, `--env`, `--tail`, `--follow`/`-f`, `--force`, `--group <name>`,
`--from <ref>`, `--path <dir>`, `--no-hydrate`, `--no-up`, `--delete-branch`,
`--keep-volumes`, `--dry-run`, `--proxy`, `--out <dir>`, `--heuristic`, `--probe`.

### Tests

`npm test` — 143 tests, no Docker required, ~90s. Unit coverage of slugs,
quoting, scope logic, config validation, leases, the registry, hydration and the
adapt renderer (byte-compared against `test/fixtures/`), plus CLI-level tests
that drive real git worktrees through real processes.

`WT_TEST_DOCKER=1 npm test` adds the suite that boots real stacks: two worktrees
at once, partial startup, the crash path, exit-code passthrough, lease stability
across `down`/`up`, and `doctor` green. Each Docker test uses its own branch, so
its Compose project cannot collide with another test or with a real worktree.

### What was proven, not just written

Two worktrees (`feature-login-rework`, `fix-billing`) brought up simultaneously
from `examples/sample-app`:

```
feature-login-rework/api  4000/tcp                     fix-billing/api  4000/tcp
feature-login-rework/web  3000/tcp                     fix-billing/web  3000/tcp
feature-login-rework/db   0.0.0.0:21176->5432/tcp      fix-billing/db   0.0.0.0:23229->5432/tcp
easy-worktree-proxy       0.0.0.0:8081->80/tcp   ← only published HTTP port machine-wide
```

`grove run node e2e.mjs` passed in both at once, each asserting the full chain
(proxy → web → `api.internal` → db) **and** that the response came from the right
worktree. Also verified: partial startup (`--group backend` → `status: ready`,
`scope: ["api","db"]`, `web: not-started`), incremental add (`grove up web` did not
restart api), fail-fast on a crashed service (9s instead of the 120s timeout, with
the real application error inline), `grove run` refusal with a JSON payload and exit 1,
exit-code passthrough (child exit 42 → `grove` exit 42), and shell quoting parity with
running the command directly.

M2 and M4 additionally verified by hand on a throwaway repo, against the compiled
`dist/`, not `tsx`:

- `grove install` → `grove adapt evidence` → `decide --heuristic` → `render` → `validate`
  produced an overlay and a `worktree.toml` that **boot to `ready` with 9/9
  doctor checks**, entirely generated, with no hand editing. That is the strongest
  claim `adapt` can currently make — and it is still one repo.
- `grove new feat/second --build` from that repo: hydrated `.env`, booted, and both
  worktrees then passed `grove run node e2e.mjs`, each asserting it was served by its
  own stack. `docker ps` showed `api 4000/tcp` and `web 3000/tcp` in both, with a
  single published HTTP port machine-wide.
- `grove rm feat-second --delete-branch` removed 3 containers, 1 volume, 1 network, 1
  lease and the branch, and left the registry and leases file exactly correct.
- **The gc safety property, twice.** With a wiped registry, `grove gc` inside the repo
  re-registered the worktree it found via git and touched nothing. Run from an
  *unrelated* repo, where the live stack was unrecognisable, it reported
  `skip unknown adapt-demo — 3 containers left alone` and left it serving.

---

## 3. The manifest — the contract everything else serves

`.wt/manifest.json`, written **inside the worktree** (gitignored). That location is
deliberate: an agent's cwd *is* the worktree, so a fixed relative path resolves
correctly with no "which worktree am I?" inference and no global registry lookup.

Written on success **and on failure**, with logs attached, so a consumer learns
*which* layer broke and why instead of finding no file.

```json
{
  "schemaVersion": 1,
  "worktree": "fix-billing",
  "branch": "fix/billing",
  "root": "…/demo-b",
  "status": "ready",
  "scope": ["api", "db"],
  "baseUrl": "http://web.fix-billing.localtest.me:8081",
  "apiUrl": "http://api.fix-billing.localtest.me:8081",
  "services": [
    { "name": "api", "layer": "backend", "status": "ready",
      "url": "…", "internalUrl": "http://api.internal:4000",
      "hostAddress": null, "health": "/healthz", "logs": "grove logs api" },
    { "name": "db", "layer": "data", "status": "ready",
      "url": null, "internalUrl": null,
      "hostAddress": "localhost:23229", "health": "exec", "logs": "grove logs db" },
    { "name": "web", "layer": "frontend", "status": "not-started", "…": "…" }
  ],
  "commands": { "e2e": "grove run node e2e.mjs" },
  "updatedAt": "2026-08-10T20:05:14.467Z"
}
```

### Rules that must not be broken

- **`status: ready` means every service in `scope` is ready — not every service in
  the compose file.** `scope` is *always* derived from `docker compose ps`, never
  from the command line. That single decision makes dependency expansion,
  incremental adds, and manual `docker compose` use all produce a manifest that
  describes reality instead of intent.
- **`not-started` ≠ `unhealthy`.** `not-started` means nobody asked for it. Without
  this distinction an agent tries to repair a service that was deliberately left
  out of scope. Statuses: `ready | starting | unhealthy | stopped | not-started`.
- **Human output can change freely; `--json` is a contract.** Never ask a model to
  parse the pretty table.
- Errors are JSON too: `{ ok: false, error, hint?, service?, logs? }`.
- Health probing goes **through the proxy URL**, not straight at the container —
  that validates routing as well as liveness and absorbs the second or two Traefik
  needs to notice a new container.

---

## 4. Traps already paid for — do not reintroduce these

Every one of these was found by running the thing, not by reading docs. Each cost
real debugging time.

1. **`!reset` erases and IGNORES any value you give it. `!override` replaces.**
   `ports: !reset ["${WT_PORT_DB}:5432"]` merges to `[]` — the database publishes
   nothing while the manifest still advertises a host address with no listener.
   Verified against Compose v5.0.2. `grove doctor` now checks both directions
   (stray published ports, and `host_port` services that publish nothing).

2. **Traefik must be ≥ 3.6 on Docker Engine 29+.** Earlier 3.x negotiates a Docker
   API version below 1.44, which Engine 29 rejects (`MinAPIVersion: 1.44`). Traefik
   still starts and still answers — **404 for everything**, with only its container
   logs explaining why. Tested: v3.3/3.4/3.5 broken, v3.6 fine. Default is now
   `traefik:v3.6`; `grove doctor` greps proxy logs for provider errors.

3. **No socket probe can tell you whether Docker can publish a port.** Bind
   `0.0.0.0` not `127.0.0.1` (Docker publishes on all interfaces, so a loopback
   probe answers an easier question) — but even that is insufficient: on this
   machine Node bound `0.0.0.0:8080` happily and Docker refused it, a Windows-level
   reservation invisible to sockets. **Docker is the only authority.**
   `dockerCanPublish()` / `findBindableProxyPort()` in `src/core/ports.ts` publish a
   throwaway container to find out; `grove doctor` uses them to suggest a verified port.

4. **Never commit `.wt/`.** A committed `state.json` makes a new worktree inherit
   another's slug, so `grove up` runs `docker compose -p <other-slug>` and **recreates
   the other worktree's containers**. Observed live: worktree B reported
   `✓ feature-login-rework (branch: fix/billing)` — slug and branch disagreeing.
   `state.json` now records the absolute `root` it was created for and
   self-invalidates when that does not match. `.gitignore` is the real fix.

5. **`shell: true` + `argv.join(" ")` destroys argument boundaries.** `grove run` must
   go through a shell on Windows (npm/pnpm/yarn are `.cmd` shims that `spawn`
   cannot exec), which means one string, not a list. Each argument is now re-quoted
   per platform by `quoteForShell()` — cmd.exe wants `"` with internal `"` doubled,
   POSIX wants `'`.

6. **An existing port lease must NOT be re-probed.** Our own running container is
   holding it, so a liveness check reports it busy and we would renumber on every
   `grove up`. Leases are authoritative; dead ones are reclaimed by `grove gc` (unbuilt).

7. **Windows directory links must be junctions.** `fs.symlink(src, dest, "junction")`
   needs no elevation and no Developer Mode, unlike a real directory symlink. Needed
   by hydration (M2, unbuilt).

8. **`*.localhost` does not resolve via the Windows resolver.** Chrome handles it
   internally, but `curl`, Node `fetch` and Playwright's request context do not.
   Default the domain to `localtest.me` (real public DNS, wildcard → 127.0.0.1).

9. **`compose ps --format json` emits NDJSON on some versions and a JSON array on
   others.** Both are handled in `core/compose.ts`; keep it that way.

10. **`buildRuntime` alone never reports `ready`.** Compose only says the container
    exists. `probeOnce()` must be called by read-only commands (`status`, `run`) or
    everything reports `starting` forever.

11. **`grove gc` must delete only what it can prove is dead, never what it fails to
    recognise.** The first cut swept every `wt.managed=true` container whose slug
    was not in the live set. That is catastrophic under an empty registry — which
    is exactly the state after deleting `~/.easy-worktree`, or when running with
    `EASY_WORKTREE_HOME` pointed elsewhere, as the test suite does: *every* stack
    on the machine looks orphaned. The rule now is that a slug is dead only when
    we hold a record of it (a registry entry or a port lease) whose worktree is
    gone; an unrecognised container is reported and left alone. The test suite
    running against the developer's own Docker daemon is what surfaced this.

12. **A module-level `const EMPTY = { worktrees: [] }` used as a read fallback is
    shared mutable state.** `readRegistry()` returned it verbatim when no file
    existed, and `register()` then pushed into that same array — so on a machine
    with no registry file, a later read of a genuinely empty registry returned the
    earlier entry from memory. Return a fresh object; copy arrays you hand out.

13. **A root-level `beforeEach` in `node:test` runs before each *suite*, not before
    each test inside it.** Per-test isolation has to be registered inside the
    `describe`. Tests that share a temp directory pass for the wrong reason, and
    trap 12 was invisible until this was fixed.

14. **Only services on the *shared* network need a `.internal` alias.** The
    ambiguity comes from every worktree attaching a service called `api` to one
    network; a private network has exactly one. `grove adapt validate` checks
    `external: true` networks and ignores the rest.

15. **`grove new` must establish identity through `loadContext`, not by slugifying the
    branch itself.** Only `loadContext` writes `.wt/state.json`, resolves a slug
    collision against sibling worktrees, and registers the result — and every
    other command reads that file.

---

## 5. What is missing

### 5.1 Automated tests — done

`npm test` (138 tests) and `WT_TEST_DOCKER=1 npm test`. See §2. The suite found
three real bugs that hand-testing had not: traps 11, 12 and 15.

Two things it deliberately does not cover, and which are still hand-verified only:

- **macOS and Linux.** See §5.6.
- **`grove install --global`**, because writing to the developer's real
  `~/.claude/settings.json` from a test is not acceptable. The repo-local path,
  which shares all of the merge logic, is covered.

### 5.2 M2 — lifecycle — done

`grove new`, hydration (`[hydrate]` + `grove hydrate`), `grove rm`, `grove gc`, and the
registry at `~/.easy-worktree/registry.json`, populated by `loadContext` so that
worktrees created by hand are known too.

Two decisions worth carrying forward:

- **`grove gc` deletes only provably-dead slugs** — see trap 11. Resist any change
  that makes "unrecognised" mean "delete".
- **The shared proxy is reaped only with `grove gc --proxy`**, not by default. It is
  machine-wide, and one repo's cleanup should not cut ingress for another's.

Still open: `grove gc` has no `--idle 7d` / `--prune 30d`. Age-based sweeping needs a
notion of last-used that nothing currently records.

### 5.3 M3 — ports and databases

Per-worktree database provisioning: `CREATE DATABASE app_<slug>` from a template,
dropped by `grove rm`. Config sketch already in the design doc
(`[database] mode = "per-worktree" | "shared"`). Also consider a shared-infra mode
(one Postgres for the machine, one logical DB per worktree) since N full stacks is
what actually exhausts the machine.

### 5.4 M4 — `grove adapt` (the migration pass) — built, lightly exercised

Built as described below and byte-tested against a fixture, but **only ever run
against `examples/sample-app`**. The heuristic decider is a starting point, not an
oracle: it has never seen a monorepo, a service with several published ports, or
an image it does not recognise in a real repo. Expect to correct
`.wt/decisions.json` by hand — which is exactly why that file exists.

The `--probe` flag observes rather than guesses, but only where observation is
cheap: it requests host ports the *base* file already publishes, so it works on a
stack you already have running and asks nothing of you. Booting an un-migrated
stack ourselves is the port collision this tool exists to avoid, so it does not.
A refused connection therefore only ever confirms HTTP, never disproves it.

Pipeline, with only ONE model step:

```
grove adapt evidence            [code]   normalize + probe + read repo  → JSON on stdout
        ↓
.wt/decisions.json           [MODEL]  ← the only AI step, and it is a FILE, not a command
        ↓
grove adapt render <file>       [code]   decisions → YAML (labels, !override, aliases)
        ↓
grove adapt validate            [code]   merge, boot, curl every generated URL
```

- **Never regex YAML.** `docker compose config --format json` resolves anchors,
  `extends`, `include`, profiles, `env_file` and interpolation for you.
- **Emit a new file; never edit theirs.** No comment/formatting round-trip problem,
  and a bad generation is one deletable file.
- **Classification: observe, don't guess.** Boot once and probe — an HTTP server
  answers `GET /` with a status line, Postgres does not. That works on
  `acme/svc-7:latest` exactly as well as on `postgres`. The known-image table is a
  *fast path*, not the decision. Also free: the image's own `EXPOSE` metadata, and a
  healthcheck that curls a path (gives you the health endpoint too).
- **Rewriting browser URLs: the published port is the join key.** `localhost:4000`
  in an env value + `api` publishing `4000` → rewrite to
  `http://api.${WT_NAME}.${WT_DOMAIN}`. Regex belongs on env *values*, never on YAML.
- **Conservative host-port rule:** if the base file published a port, the author
  wanted to reach that thing — keep it reachable on a *leased* port. If they did not
  publish it, leave it internal.
- The model returns **structured decisions** (schema with required `evidence` and
  `confidence`); deterministic code renders the YAML. Anything `unsure` is
  auto-demoted to a review list rather than silently applied. Probe results always
  win over the model.
- `grove adapt decide --heuristic` (no AI, offline/CI) and `--auto` (shell out) fill the
  same slot when there is no session.

### 5.5 Distribution and agent integration — built

`grove install` writes the skill, `.claude/commands/setup-grove.md`, merged
hook entries, the `.gitignore` rule, and an `AGENTS.md` section when that file
already exists. It does **not** create the overlay — that needs judgment, and is
`grove adapt`.

Decisions that must not be undone:

- **The hook command is resolved at write time** — global `grove` if `which` finds
  it, else `npx --no-install git-grove`. A hook pointing at a binary not on
  PATH fails *silently*: the session starts, nothing is injected, and nothing
  anywhere says why.
- **Hooks are merged, never rewritten.** Replacing `settings.json` wholesale would
  delete the user's own hooks.
- **`SessionEnd` cannot ask a question**, so only `down` (reversible) is
  automatable there, never `rm`. Default is `off` even for `down`.
- **One skill, one slash command.** Skills are selected by description matching
  and overlapping ones compete.

Still unbuilt: `npx git-grove install` as a bare-repo bootstrap (adding the
dependency itself), and the `--auto` decider that shells out to a headless
`claude -p …` / `codex exec …`. Both `claude` (2.1.225) and `codex` (0.144.4) are
installed on this machine; `claude -p "…" --output-format json --model haiku
--allowedTools Read,Glob,Grep --permission-mode dontAsk` gives a clean parse,
`codex exec "…"` needs fenced-JSON extraction. The zero-token property holds
either way: the tool never reads, stores or transmits a credential.

### 5.6 Other platforms

Only Windows 11 / Docker Desktop 29.2 / Compose 5.0.2 / Node 24 has been exercised.
Untested on macOS and Linux, and the riskiest parts are exactly the ones that fought
back: the `junction` link type is Windows-only, and the `/var/run/docker.sock` mount
differs across Docker hosts.

### 5.7 Known-but-unenforced

The **shared-network alias collision** is now checked by `grove adapt validate`, and
`grove adapt render` always emits the aliases. It is still not checked by
`grove doctor`, so a hand-written overlay that skips `validate` can still ship it —
and it works with one worktree, going ambiguous only with two.

Also still open:

- **`grove down` on the last worktree** leaves the shared proxy running unless you
  pass `grove gc --proxy`. That is deliberate (§5.2), but it means the default state
  after a day's work is one idle container.
- **`grove rm` cannot drop a per-worktree logical database**, because §5.3 is
  unbuilt. Today every worktree has its own Postgres *container*, so
  `down --volumes` is a complete teardown; that stops being true the moment
  shared-infra mode exists.
- **Age-based `grove gc`** (`--idle 7d`) needs a last-used timestamp nothing records.

---

## 6. The machine these were found on

- Windows 11, Node 24.15.0, Docker 29.2.0 (API 1.53, **MinAPIVersion 1.44**),
  Compose v5.0.2, Claude Code 2.1.225, Codex 0.144.4.
- **`:80` is held by `com.docker.backend` with zero containers running**, and Docker
  refuses `:8080` via an invisible Windows reservation. The fixture uses
  **`[proxy] port = 8081`**. `grove doctor` will now suggest a Docker-verified port.
- Docker Desktop may need starting: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.
- Git Bash mangles `/var/run/...` into `C:\Program Files\Git\var\...` on the command
  line. Use `MSYS_NO_PATHCONV=1` for ad-hoc `docker run -v` tests. Compose files are
  read directly by Docker and are **not** affected.
- Foreground `sleep` is blocked in this harness; poll in a loop or use background
  commands.

---

## 7. How to run and verify

The automated route, which is now the primary one:

```bash
cd <this repo>
npm install
npm run typecheck
npm test                       # 143 tests, no Docker, ~90s
WT_TEST_DOCKER=1 npm test      # + boots real stacks, ~3 min
```

The Docker suite builds throwaway repos from `examples/sample-app`, each on its
own branch, so it will not touch a stack you have running. It tears itself down
in `finally` blocks; if a run is killed mid-way, `grove gc --dry-run` from any repo
will show what was left and `docker ps --filter label=wt.managed=true` is the
ground truth.

By hand, end to end:

```bash
npm run build
cp -r examples/sample-app/. /tmp/demo && cd /tmp/demo
git init -q && git add -A && git commit -qm init

node <repo>/dist/cli.js doctor            # expect 9/9 green
node <repo>/dist/cli.js new feat/x        # branch + worktree + hydrate + up
cd ../demo-feat-x
node <repo>/dist/cli.js run node e2e.mjs  # asserts proxy → web → api → db
docker ps --format '{{.Label "com.docker.compose.project"}} {{.Ports}}'
# expect identical internal ports, one published HTTP port machine-wide

node <repo>/dist/cli.js rm feat-x --delete-branch --force
```

Teardown of the shared parts: `grove gc --proxy`, or by hand
`docker compose -f ~/.easy-worktree/proxy/docker-compose.yml -p easy-worktree-proxy down`
and `docker network rm wt-proxy`.

---

## 8. File map

```
src/
  cli.ts              arg parsing, dispatch, exit codes, `run` arg splitting
  types.ts            Manifest / Config / statuses — the public contract
  index.ts            library exports
  core/
    config.ts         worktree.toml load + validate (typed accessors, named errors)
    context.ts        repo root, branch, slug, .wt/state.json, URL construction,
                      resolveSelection (services + groups)
    naming.ts         slugify / uniqueSlug (DNS + compose + db safe), envKey
    exec.ts           spawn wrapper, execOrThrow, which, sleep
    lock.ts           mkdir-based cross-platform lock, atomic readJson/writeJson
    ports.ts          leases (deterministic offset + probe), isPortFree(0.0.0.0),
                      dockerCanPublish / findBindableProxyPort
    compose.ts        argv + env construction, composePs (scope), composeLogs
    proxy.ts          shared traefik lifecycle, recreate on image change,
                      PortUnavailableError, proxyLogs / proxyProviderBroken
    health.ts         buildRuntime, probeOnce, waitReady (fail-fast on exited)
    manifest.ts       stackStatus (scope-relative), build / read / write
    output.ts         ANSI-aware table, printManifest, fail() → JSON or human
    git.ts            porcelain worktree parsing, add / remove / prune / dirty
    registry.ts       ~/.easy-worktree/registry.json — the only cross-repo index
    worktrees.ts      git + registry + manifest joined; resolveWorktree, liveSlugs
    docker.ts         label-driven sweeps (works when the compose files are gone)
    hydrate.ts        copy / link / run, lockfile comparison, junctions
    glob.ts           the small matcher hydration patterns need
    adapt/
      evidence.ts     compose config --format json, image metadata, known-image table
      decide.ts       heuristic decisions, env-URL rewriting (internal vs browser)
      render.ts       decisions → overlay YAML + worktree.toml, deterministic
  commands/           new, up, down, rm, gc, run, status, logs, ls, hydrate,
                      adapt, install, hook, doctor
test/
  helpers.ts          temp repos, CLI-as-a-process runner, isolated state dirs
  unit/               naming, manifest, config, hydrate, state, adapt
  integration/        lifecycle (git, no Docker) + stack (WT_TEST_DOCKER=1)
  fixtures/           decisions.json + the byte-compared render output
examples/sample-app/  fixture: web + api + postgres, overlay, worktree.toml, e2e.mjs
templates/skills/     the daily-use SKILL.md shipped by `install`
templates/commands/   /setup-grove, which drives the adapt loop
```


---

## 9. Recommended next step

**Run it against a second, real repository.** Everything here has been proven
against one fixture on one machine. The parts most likely to be wrong are the
ones that have never met a real repo: the `adapt` heuristics (§5.4), and
hydration against a monorepo with nested lockfiles.

Then, in order:

1. **macOS and Linux** (§5.6). CI covers the non-Docker suite on all three
   platforms; the Docker suite runs on Linux only, because the hosted Windows and
   macOS runners have no daemon. The `junction` link type and the
   `/var/run/docker.sock` mount are the two things most likely to break.
2. **M3, shared-infra mode** (§5.3). N full stacks is what actually exhausts a
   machine, and one Postgres with a logical database per worktree is the fix.
   `grove rm` will then need to drop that database — today `down --volumes` is a
   complete teardown only because each worktree owns its container.
3. **`grove adapt decide --auto`** (§5.5), shelling out to a headless agent so the
   migration works with no session attached.

What *not* to do: do not loosen `grove gc`'s "prove it is dead" rule (trap 11), and
do not let a model emit YAML directly instead of decisions (§5.4). Both trade a
reviewable artifact for a failure you only notice in production.
