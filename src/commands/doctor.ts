import dns from "node:dns/promises";
import { composeConfig } from "../core/compose.js";
import { loadContext } from "../core/context.js";
import { exec } from "../core/exec.js";
import { c, printJson } from "../core/output.js";
import { dockerCanPublish, findBindableProxyPort } from "../core/ports.js";
import { proxyLogs, proxyProviderBroken, proxyStatus } from "../core/proxy.js";

export interface DoctorOptions {
  json: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

/** `ports: !reset []` in the overlay needs Compose 2.24 or newer. */
const MIN_COMPOSE = [2, 24, 0] as const;

function parseVersion(text: string): number[] | null {
  const m = text.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gte(a: number[], b: readonly number[]): boolean {
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function doctor(opts: DoctorOptions): Promise<void> {
  const checks: Check[] = [];

  const dockerVersion = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  checks.push({
    name: "docker",
    ok: dockerVersion.code === 0,
    detail: dockerVersion.code === 0 ? dockerVersion.stdout.trim() : "not reachable",
    hint: dockerVersion.code === 0 ? undefined : "is Docker Desktop running?",
  });

  const composeVersion = await exec("docker", ["compose", "version"]);
  const parsed = parseVersion(composeVersion.stdout);
  checks.push({
    name: "compose >= 2.24",
    ok: parsed !== null && gte(parsed, MIN_COMPOSE),
    detail: parsed ? parsed.join(".") : "unknown",
    hint: "the `!reset` tag used by the overlay needs Compose 2.24+",
  });

  let ctxOk = false;
  try {
    const ctx = await loadContext();
    ctxOk = true;

    checks.push({
      name: "config",
      ok: true,
      detail: `${ctx.config.services.length} services, domain ${ctx.config.domain}`,
    });

    const merged = await composeConfig(ctx);
    checks.push({
      name: "compose files merge",
      ok: merged.code === 0,
      detail: merged.code === 0 ? ctx.config.project.compose.join(" + ") : "merge failed",
      hint: merged.code === 0 ? undefined : merged.stderr.trim().split("\n").slice(-3).join(" "),
    });

    // The published-port check: an ingress service that still publishes a host
    // port has not actually been migrated, and will collide across worktrees.
    if (merged.code === 0) {
      try {
        const doc = JSON.parse(merged.stdout) as {
          services?: Record<string, { ports?: unknown[] }>;
        };
        const offenders = ctx.config.services
          .filter((s) => s.subdomain && !s.hostPort)
          .filter((s) => (doc.services?.[s.name]?.ports ?? []).length > 0)
          .map((s) => s.name);
        checks.push({
          name: "no stray published ports",
          ok: offenders.length === 0,
          detail: offenders.length === 0 ? "clean" : `still publishing: ${offenders.join(", ")}`,
          hint: offenders.length === 0 ? undefined : "add `ports: !reset []` in the overlay",
        });

        // The mirror-image failure: a service we advertise a host address for that
        // in fact publishes nothing. Silent otherwise — WT_HOST_<X> would point at
        // a port with no listener. Almost always `!reset [value]` where the value
        // was ignored; `!reset` erases, only `!override` replaces.
        const notPublished = ctx.config.services
          .filter((s) => s.hostPort)
          .filter((s) => (doc.services?.[s.name]?.ports ?? []).length === 0)
          .map((s) => s.name);
        checks.push({
          name: "host_port publishes",
          ok: notPublished.length === 0,
          detail:
            notPublished.length === 0
              ? "clean"
              : `declared host_port but publishes nothing: ${notPublished.join(", ")}`,
          hint:
            notPublished.length === 0
              ? undefined
              : "`ports: !reset [value]` erases the value — use `!override` to replace it",
        });
      } catch {
        /* merged output wasn't JSON; the merge check above already reported */
      }
    }

    const host = `probe.${ctx.slug}.${ctx.config.domain}`;
    try {
      const { address } = await dns.lookup(host);
      const loopback = address === "127.0.0.1" || address === "::1";
      checks.push({
        name: "wildcard DNS",
        ok: loopback,
        detail: `${host} -> ${address}`,
        hint: loopback ? undefined : "the domain must resolve to loopback; try domain.suffix = \"localtest.me\"",
      });
    } catch {
      checks.push({
        name: "wildcard DNS",
        ok: false,
        detail: `${host} does not resolve`,
        hint: "*.localhost does not resolve via the Windows resolver — use localtest.me",
      });
    }

    const proxy = await proxyStatus(ctx.config);
    if (proxy.running) {
      checks.push({ name: "proxy", ok: true, detail: `running on :${proxy.port}` });
    } else {
      // Ask Docker, not a socket. A probe is not authoritative in either
      // direction, so when the configured port is refused we go find one that
      // Docker has actually accepted and name it — no guessing for the user.
      const usable = await dockerCanPublish(proxy.port, ctx.config.proxy.image);
      const suggestion = usable
        ? null
        : await findBindableProxyPort(proxy.port, ctx.config.proxy.image);

      checks.push({
        name: "proxy",
        ok: usable,
        detail: usable
          ? `not running, docker can publish :${proxy.port}`
          : `docker refuses :${proxy.port}`,
        hint: usable
          ? undefined
          : suggestion
            ? `set [proxy] port = ${suggestion} in worktree.toml — verified bindable just now`
            : `no candidate port was bindable; is the Docker daemon healthy?`,
      });
    }

    // A Traefik that cannot read the Docker socket still starts and still answers
    // — with 404 for everything. Without this check that looks like a routing bug.
    if (proxy.running) {
      const broken = proxyProviderBroken(await proxyLogs());
      checks.push({
        name: "proxy -> docker api",
        ok: !broken,
        detail: broken ? `${ctx.config.proxy.image} cannot read the docker socket` : "reachable",
        hint: broken
          ? `Traefik < 3.6 negotiates a Docker API version below 1.44 and cannot talk to ` +
            `Docker Engine 29+. Set [proxy] image = "traefik:v3.6" and run \`wt up\` again.`
          : undefined,
      });
    }
  } catch (err) {
    if (!ctxOk) {
      checks.push({
        name: "config",
        ok: false,
        detail: (err as Error).message,
        hint: "run this from inside a worktree that has worktree.toml",
      });
    }
  }

  const ok = checks.every((ch) => ch.ok);

  if (opts.json) {
    printJson({ ok, checks });
  } else {
    for (const ch of checks) {
      const mark = ch.ok ? c.green("✓") : c.red("✗");
      console.log(`${mark} ${ch.name.padEnd(24)} ${c.dim(ch.detail)}`);
      if (!ch.ok && ch.hint) console.log(`  ${c.dim("hint: " + ch.hint)}`);
    }
  }

  if (!ok) process.exitCode = 1;
}
