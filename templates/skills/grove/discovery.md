# Discovery: find every port, and whether grove can move it

Reference for the discovery agents dispatched by `/setup-grove`. Each agent owns
one **axis** and reads only for that axis. The orchestrator merges the results.

Two facts about a port matter, and only the second is hard:

1. **Where it is** - a number in a file.
2. **Whether it is movable** - can grove hand this process a different port, and
   through what?

A port grove cannot move is the thing that stops two worktrees running at once.
Finding those is the job.

## Reading yields a candidate, never a verdict

You are reading source. Source tells you a process *intends* to read a config
key. It cannot tell you the process *honours* it - a service may read
`Ports:Api`, hand it to a framework, and have the framework ignore it in favour
of something else entirely.

So: report what the code says, with `confidence`. Never report a port as
working. The live audit in [`verify.md`](verify.md) decides that, and it runs
after you.

## The `movable` verdict

Every finding carries one of three values. This is the field the orchestrator
acts on.

| `movable` | Meaning | What grove does |
|---|---|---|
| `runtime` | Read at startup from an env var, a config file, or a CLI flag | `[env]` or `[render]` - no source change |
| `build` | Frozen into an artifact at build time | Build-time injection, or the value is per-worktree at build |
| `no` | A literal in code with no override | **Blocker.** Needs a source change, and the user decides |

`build` is its own case because setting it at runtime silently does nothing -
the process starts, reads the baked value, and binds the wrong port with no
error anywhere.

## The axes

### 1. `profiles` - how a developer starts each thing

The declared entry points, and any port a launcher pins before the process even
runs.

`package.json` scripts · `Procfile` · `Makefile` · `justfile` · `Taskfile.yml` ·
`launchSettings.json` · `.vscode/launch.json` · `.idea/runConfigurations` ·
`docker-compose*.yml` · `devcontainer.json` · `tox.ini` · `manage.py` ·
`mix.exs` · `Rakefile` · `air.toml` · `nodemon.json` · `ecosystem.config.js` ·
`supervisord.conf` · systemd units

A launcher that sets ports **over** the ambient environment is the finding that
matters most here - `dotnet run` applying a launch profile, `docker compose`
applying `environment:`, `npm start` sourcing a `.env`. Record the flag that
skips it, if one exists (`--no-launch-profile`, `--env-file`).

### 2. `bindsite` - where the socket is actually opened

The call that binds. For each one, trace the value backwards to its origin: a
literal, an env read, a config key, or a CLI flag.

| Ecosystem | What to grep for |
|---|---|
| Node | `.listen(` · `createServer` · `Bun.serve` · `Deno.serve` · `fastify({port` |
| Python | `uvicorn.run` · `app.run(` · `runserver` · `--bind` (gunicorn) · `HTTPServer((` |
| .NET | `UseUrls(` · `ListenAnyIP(` · `ListenLocalhost(` · `ConfigureKestrel` · `ASPNETCORE_URLS` · `Kestrel:Endpoints` |
| Go | `http.ListenAndServe` · `net.Listen(` · `srv.Addr` |
| Java / Spring | `server.port` in `application.{properties,yml}` · `SERVER_PORT` · `Undertow.builder().addHttpListener` |
| Ruby | `config/puma.rb` `port` · `rails s -p` |
| Rust | `TcpListener::bind` · `.bind((` (axum/actix/rocket) · `Rocket.toml` |
| PHP | `php -S` · `artisan serve --port` |
| Elixir | `http: [port:` in `config/*.exs` |

The distinction that decides `movable`:

- `listen(process.env.PORT || 3000)` -> `runtime`, key `PORT`
- `listen(3000)` -> `no`
- `listen(config.get('ports.api'))` -> `runtime`, key `ports.api`, and say which
  file that config loads from

### 3. `devservers` - dev servers and their proxy targets

Two ports per dev server, and they move independently: the port it **binds**,
and the port it **proxies to**. Move the backend without moving the proxy target
and the UI loads while every call through it fails - which reads as a broken
app, not a config gap.

`vite.config.*` · `next.config.*` · `webpack.config.*` · `angular.json` ·
`nuxt.config.*` · `astro.config.*` · `svelte.config.js` · `.storybook/main.*` ·
`craco.config.js` · `package.json` `proxy` field

Report both, as separate findings: `kind: "bind"` and `kind: "reference"`.

### 4. `buildtime` - values frozen before the process starts

Set these at runtime and nothing happens. That silence is why they cost whole
sessions.

- Bundler-inlined env: `NEXT_PUBLIC_*` · `VITE_*` · `REACT_APP_*` · `PUBLIC_*` ·
  `GATSBY_*` · any `import.meta.env` / `process.env` read in browser code
- Bundler defines: webpack `DefinePlugin` · esbuild/vite `define` · rollup
  `replace`
- MSBuild properties, and generated files such as `spa.proxy.json`
- Docker `build.args` and anything `ARG`-baked into an image
- Go `-ldflags -X` · Rust `env!()` · Java annotation-processed constants
- Generated clients: OpenAPI/gRPC codegen with a baked base URL

**A build-tool variable can reach more than one project at once.** MSBuild
surfaces environment variables as properties to every project in the build;
`VITE_*` reaches every Vite app sharing a `.env`. Where two services read one
name, that is a finding - flag it, because the fix is a distinct name per
service, not a shared value.

### 5. `orchestrator` - one process that launches others

.NET Aspire AppHost · docker-compose · PM2 · foreman/overmind/honcho ·
turbo/nx · tilt/skaffold · k8s manifests used for local dev · any custom
`scripts/dev` that spawns children

Record what it launches, what it injects into each child, **and whether the
child's bind site reads what it was handed** - cross-check against axis 2. An
orchestrator assigning a port proves nothing on its own; a child that calls
`UseUrls()` from its own config key binds that key and ignores the assignment.

Also record how the orchestrator's own ports are set - a dashboard, a control
API, an OTLP endpoint. Those collide between worktrees too.

### 6. `references` - hardcoded addresses in things that *talk to* services

The axis that bites after every bind site is fixed. A server on a leased port is
useless if a client still dials the old one.

Grep broadly for `localhost:<port>` · `127.0.0.1:<port>` · `0.0.0.0:<port>` ·
`http://.*:\d{4,5}` across:

- frontend API clients and `fetch`/`axios` base URLs
- test configs - Playwright `baseURL`, Cypress `baseUrl`, integration test setup
- `.env*` files of every flavour
- reverse-proxy config: `nginx.conf`, `Caddyfile`, `haproxy.cfg`
- CI workflows, seed scripts, healthcheck scripts, Postman/Bruno collections
- README and docs commands a developer copy-pastes

Report these as `kind: "reference"` with the service they point at, when you can
tell. A reference whose target port is moving must move with it.

## Output

Return JSON only. No prose.

```json
{
  "axis": "bindsite",
  "findings": [
    {
      "service": "portal",
      "port": 5005,
      "kind": "bind",
      "file": "Portal/Api/appsettings.json",
      "line": 12,
      "how": "config_key",
      "key": "Kestrel:Endpoints:Https:Url",
      "movable": "runtime",
      "evidence": "Kestrel endpoint section; Program.cs does not call UseUrls",
      "confidence": "medium"
    }
  ],
  "unsure": ["scripts/dev.sh line 40 execs a binary I could not locate"]
}
```

- `kind` - `bind` (opens the socket) · `reference` (dials it) · `reservation`
  (a port named in config that nothing here binds)
- `how` - `literal` · `env` · `config_key` · `cli_flag` · `derived` · `build_arg`
- `service` - your best name for it; the orchestrator reconciles names across
  axes. Same string for the same thing wherever you can.
- `confidence` - `low` whenever you inferred rather than read. Low-confidence
  findings are checked, not discarded.

Put anything you could not resolve in `unsure`. A gap named there gets followed
up; a gap smoothed over becomes a port collision three steps later.
