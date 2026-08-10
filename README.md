# easy-worktree

Every git worktree gets its own fully-deployed, independently addressable stack —
no port juggling, no config rewriting, and a machine-readable manifest so an agent
can find it and test against it.

**Status: M1.** `up` / `down` / `run` / `status` / `logs` / `ls` / `doctor` work and
are verified end to end. `wt new`, `wt rm`, `wt gc` and `wt adapt` are not built yet.

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

**`worktree.toml`** — see [`examples/sample-app`](examples/sample-app) for a
complete, working one.

Then:

```bash
wt doctor        # verify the environment and the migration
wt up            # start and wait until healthy
wt run pnpm e2e  # BASE_URL/API_URL injected, exit code passed through
```

## Gotchas this repo learned the hard way

All of these were found by running it, not by reading docs.

**`!reset` erases, `!override` replaces.** `ports: !reset ["8080:80"]` silently
publishes *nothing* — the value is ignored. Use `!override` whenever you mean
"replace with this". `wt doctor` checks for it.

**Traefik must be ≥ 3.6 on Docker Engine 29+.** Earlier 3.x negotiates a Docker API
version below 1.44, which Engine 29 rejects. Traefik still starts and still
answers — with 404 for everything, and only its container logs say why. `wt doctor`
checks this too.

**A socket probe cannot predict whether Docker can publish a port.** On Windows a
port can be reserved such that `docker run -p` fails while a plain `listen` on
`0.0.0.0` succeeds. Docker is the authority; the pre-check is advisory.

**Docker Desktop on Windows often holds `:80`** with no containers running. Set
`[proxy] port` — URLs then include the port, which works fine.

**Never commit `.wt/`.** A committed `state.json` makes a new worktree inherit
another worktree's slug and drive its containers. The tool now discards state
whose recorded `root` doesn't match, but the `.gitignore` entry is the real fix.

**`*.localhost` does not resolve via the Windows resolver.** Chrome handles it
internally, but `curl`, Node `fetch` and Playwright's request context do not.
Default the domain to `localtest.me`.

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

Human output can change freely; `--json` is a contract.

## Development

```bash
npm install
npm run build
npm run typecheck
```
