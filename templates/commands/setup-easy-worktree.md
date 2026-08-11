---
description: Migrate this repo so every git worktree runs its own isolated stack
---

Set this repository up for `wt` (easy-worktree). Work through the steps in order
and stop at the first one that fails — a later step assumes the earlier one held.

## 1. Gather evidence (no guessing)

```
wt adapt evidence --json
```

This runs `docker compose config --format json`, so anchors, `extends`,
`include`, profiles and `env_file` are already resolved. **Never read the compose
YAML with a regex** — read this output.

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
