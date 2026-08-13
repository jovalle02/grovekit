---
description: Migrate this repo so several git worktrees run their own stacks at once
---

Set this repository up for `grove` (grove-worktree). **You are doing this, not
the user** - they run this command and read your report. The only things they
decide are the ones you cannot answer from the code: whether to change source,
and whether new worktrees copy the data.

**One tree is not a grove.** The deliverable is several worktrees serving at the
same time. A single stack booting green is the state this repo was already in -
it proves nothing. You are finished after the grove test in step 6, and not
before.

Work the steps in order; each assumes the one before it held. Two of them stop
and ask - that is the design, not a failure.

## 0. Which shape is this repo?

```
grove adapt evidence --json
```

Read `containerised`:

- **`true`** - there is a compose file. `grove adapt` does the heavy lifting;
  your judgment goes into the decisions file. Do steps 1c-2c.
- **`false`** - the ports live in code. You write `worktree.toml` yourself from
  the discovery findings. Do steps 1h-2h.

Both, commonly: containerised services plus processes on the host. Do both, then
merge into one `worktree.toml`.

Every shape converges on steps 3-7. The audit and the grove test are not
optional for the containerised path - a compose file makes collisions *likelier*
to be handled, never certain.

## 1c. Evidence, containerised

Step 0 already ran `docker compose config --format json`, so anchors, `extends`,
`include`, profiles and `env_file` are resolved. **Read that output, never the
compose YAML with a regex.**

Per service it reports image, build context, published ports, `expose`,
environment, `depends_on`, any healthcheck, and a `guess` from the known-image
table. The guess is a fast path, not a decision.

## 2c. Decide and render

Write `.wt/decisions.json` - a file, so it is reviewable and re-runnable. Start
from the heuristic and correct it:

```
grove adapt decide --heuristic --json
```

Per service: **`kind`** (`http` / `tcp` / `worker`), **`layer`**
(`frontend` / `backend` / `worker` / `data` / `infra`), **`subdomain`** for
`http`, **`hostPort`** only for `tcp` things a developer opens in a GUI client,
and **`health`**.

- If the base compose file published a port, the author wanted to reach that
  thing - keep it reachable, on a leased port. If they did not, leave it
  internal.
- A Postgres exec check needs `-h`: `["pg_isready", "-h", "127.0.0.1", "-U", "app"]`.
  Without it the check talks to the unix socket, which the bootstrap server
  Postgres runs during `initdb` also answers - so the stack reports ready and
  the next command finds the connection closed under it.
- Every entry carries `evidence` and `confidence`. `confidence: "low"` lands it
  on a review list instead of being silently applied.

Browser-facing env vars are the only ones that change per worktree.
`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` are read by a browser, which is not on
the Docker network, so they take the external hostname. `DATABASE_URL` and
server-to-server calls stay on service names, byte-identical everywhere. Those
same vars are **baked at build time** - under `environment:` they do nothing for
the browser bundle; they belong in `build.args`, or the app serves a runtime
`/env.js`.

```
grove adapt render --json
```

Deterministic, no model. Read both generated files and check two mechanical
traps: `!reset` **erases and ignores any value you give it** (`ports: !reset
["${WT_PORT_DB}:5432"]` publishes nothing - use `!override` when you mean
"replace with this"), and every service needs a `<name>.internal` alias, because
a bare `api` is ambiguous on a shared network where every worktree has one.

Then `grove adapt validate --json`.

## 1h. Discovery, ports-in-code

Read [`.claude/skills/grove/discovery.md`](../skills/grove/discovery.md) - it
defines the axes, the `movable` verdict and the output schema.

**Dispatch six subagents in parallel, in a single message.** One per axis:
`profiles`, `bindsite`, `devservers`, `buildtime`, `orchestrator`,
`references`. Give each the same brief: read `discovery.md`, own your axis
only, return the JSON schema, put anything unresolved in `unsure`.

Six readers rather than one because the axes are independent and a single reader
forms a hypothesis early and stops looking. They are read-only, so they cannot
conflict.

Done when all six returned. Read their `unsure` entries and resolve what you can
yourself - a named gap is cheap now and a port collision later.

## 2h. Synthesis

Read [`.claude/skills/grove/config.md`](../skills/grove/config.md) and write
`worktree.toml` yourself, in one pass over all six results.

**One author.** The findings arrive in parallel; the config does not. Every
collision in `config.md` - two services reading one key, a reference pointing at
a moving port, a child that ignores its parent's assignment - is invisible to
anyone holding a single service. That is why this step is not fanned out.

## 3. Audit

Read [`.claude/skills/grove/verify.md`](../skills/grove/verify.md) and run the
audit: boot once, list the live listeners, compare against the leases.

This is the step that produces facts. Until it has run, every claim about which
ports work is an inference from source - so write no "this one works" comment,
in the config or to the user, before it does.

If a service never starts, the stuck protocol in `verify.md` applies: a parent
that outlives its crashed child looks exactly like a slow build.

## 4. Blocker gate

Per the gate in `verify.md`: if the audit found services ignoring their leases,
or discovery found `movable: "no"`, **report and wait for the user here.**

Setup is **blocked**, not finished. Give them the list, the smallest change per
service, and ask. Source changes are theirs to approve.

Resume at step 5 with whatever they decided - including "leave it", which makes
the grove test fail on those services and is a legitimate answer to report.

## 5. Does a new worktree need a copy of the data?

```
grove seed --json
```

Read-only: the databases in this stack, whether they are running, and how large.

- `databases` empty, or every entry `hasData: false` - **ask nothing.** Say so
  in the report and move on.
- An entry has `hasData: true` - **ask, and wait.** With the size in it:

> `main` has a database with data in it (`db`, 260 MB). Every new worktree
> starts with an empty one. Should `grove new` copy it, so a new branch starts
> from the same data? It adds a few minutes to creating each worktree. If your
> migrations and seeds rebuild the data on boot, say no.

**Yes** - append the `from` value that `grove seed --json` reported:

```toml
[seed]
from = "main"
```

**No** - write nothing; `grove new <branch> --seed-from main` stays available
for the one-off.

This is the user's call - it makes every future `grove new` slower for everyone
on the repo. `grove adapt render --force` rewrites `worktree.toml`, so re-add
the key if that ever happens.

## 6. The grove test

Run it as written in `verify.md`: commit the config, `grove new`, then confirm
both worktrees reach `ready`, hold disjoint ports, **serve** a real endpoint,
and answer as themselves rather than proxying to each other.

This is the acceptance criterion. Report it passed only if you ran it; if you
skipped it, say you skipped it and why.

## 7. Report

- the grove test result, first - it is what the user asked for
- every port now leased, and which key moves it
- anything still hardcoded, the change you would suggest, and whether they took
  it
- anything at `confidence: "low"` worth their eye
- whether new worktrees copy the database
- the commands they now have: `grove new <branch>`, `grove up`, `grove run <cmd>`

Lead with what is not working. A summary that opens with successes and buries
the gap reads as done, and the gap resurfaces days later as a port collision
nobody connects back to setup.
