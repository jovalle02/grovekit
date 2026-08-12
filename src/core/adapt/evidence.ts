import path from "node:path";
import { exec } from "../exec.js";
import { exists } from "../glob.js";
import type { Layer } from "../../types.js";

export const EVIDENCE_SCHEMA_VERSION = 1;

/** What a service is, as far as the outside world is concerned. */
export type ServiceKind = "http" | "tcp" | "worker";
export type Confidence = "high" | "medium" | "low";

export interface PortEvidence {
  /** Host port the base file published, or null for `expose`-only. */
  published: number | null;
  target: number;
  protocol: string;
}

export interface ServiceEvidence {
  name: string;
  image: string | null;
  build: boolean;
  ports: PortEvidence[];
  /** From `expose:` in the file and `EXPOSE` in the image metadata. */
  expose: number[];
  environment: Record<string, string>;
  dependsOn: string[];
  healthcheck: string[] | null;
  volumes: string[];
  /**
   * Fast-path classification from the image name. A *hint*, never the decision:
   * it says nothing at all about `acme/svc-7:latest`, which is most of the
   * services in a real repo.
   */
  guess: { kind: ServiceKind; layer: Layer; port: number | null; evidence: string; confidence: Confidence };
  /** Only present with `--probe`: what the running base stack actually answered. */
  probe?: { port: number; http: boolean; status: number | null };
}

export interface Evidence {
  schemaVersion: number;
  project: string;
  root: string;
  composeFiles: string[];
  /**
   * False when the repo has no compose file at all - the other supported shape,
   * and the one `adapt` cannot do for you, because there is no machine-readable
   * description of the services to read.
   */
  containerised: boolean;
  services: ServiceEvidence[];
  warnings: string[];
}

/** Base compose files, newest convention first. Our own overlay is never included. */
const COMPOSE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
const OVERLAY_NAME = "docker-compose.worktree.yml";

/**
 * Image -> what it is. A fast path only.
 *
 * The reliable signal is behavioural: an HTTP server answers `GET /` with a
 * status line and Postgres does not. This table exists so the common case needs
 * no boot, and it must never be allowed to overrule an observation.
 */
const KNOWN_IMAGES: { match: RegExp; kind: ServiceKind; layer: Layer; port: number; health?: string[] }[] = [
  { match: /^(docker\.io\/)?(library\/)?postgres/, kind: "tcp", layer: "data", port: 5432, health: ["pg_isready"] },
  { match: /^(docker\.io\/)?(library\/)?(mysql|mariadb)/, kind: "tcp", layer: "data", port: 3306, health: ["mysqladmin", "ping", "-h", "127.0.0.1"] },
  { match: /^(docker\.io\/)?(library\/)?mongo/, kind: "tcp", layer: "data", port: 27017, health: ["mongosh", "--quiet", "--eval", "db.runCommand('ping')"] },
  { match: /^(docker\.io\/)?(library\/)?(redis|valkey)/, kind: "tcp", layer: "data", port: 6379, health: ["redis-cli", "ping"] },
  { match: /^(docker\.io\/)?(library\/)?memcached/, kind: "tcp", layer: "data", port: 11211 },
  { match: /elasticsearch|opensearch/, kind: "http", layer: "data", port: 9200 },
  { match: /clickhouse/, kind: "tcp", layer: "data", port: 9000 },
  { match: /cassandra|scylla/, kind: "tcp", layer: "data", port: 9042 },
  { match: /rabbitmq/, kind: "tcp", layer: "infra", port: 5672 },
  { match: /kafka|redpanda/, kind: "tcp", layer: "infra", port: 9092 },
  { match: /zookeeper/, kind: "tcp", layer: "infra", port: 2181 },
  { match: /nats/, kind: "tcp", layer: "infra", port: 4222 },
  { match: /etcd/, kind: "tcp", layer: "infra", port: 2379 },
  { match: /minio/, kind: "http", layer: "infra", port: 9000 },
  { match: /(mailhog|mailpit|maildev)/, kind: "http", layer: "infra", port: 8025 },
  { match: /localstack/, kind: "http", layer: "infra", port: 4566 },
  { match: /^(docker\.io\/)?(library\/)?nginx/, kind: "http", layer: "infra", port: 80 },
  { match: /^(docker\.io\/)?(library\/)?(caddy|httpd)/, kind: "http", layer: "infra", port: 80 },
  { match: /traefik/, kind: "http", layer: "infra", port: 80 },
];

export async function findComposeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of COMPOSE_CANDIDATES) {
    if (await exists(path.join(root, name))) {
      found.push(name);
      break; // Compose itself uses only the first match of this list.
    }
  }
  for (const name of ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yml"]) {
    if (await exists(path.join(root, name))) found.push(name);
  }
  return found.filter((f) => f !== OVERLAY_NAME);
}

/**
 * Read the repo's compose setup as resolved data, not as text.
 *
 * `docker compose config --format json` expands anchors, `extends`, `include`,
 * profiles, `env_file` and `${VAR}` interpolation. Doing any of that ourselves  - 
 * or, worse, regexing the YAML - reproduces a parser Docker already ships and
 * gets a different answer than the thing that will actually run.
 */
export async function gatherEvidence(
  root: string,
  opts: { files?: string[]; probe?: boolean } = {},
): Promise<Evidence> {
  const warnings: string[] = [];
  const files = opts.files?.length ? opts.files : await findComposeFiles(root);

  // A repo with no compose file is not a failure - it is the other supported
  // shape, and the one `adapt` genuinely cannot do for you: there is no
  // machine-readable description of the services to read, so they have to be
  // identified from the code. Say that plainly rather than throwing. The caller
  // is usually an agent following the setup command, and an exception tells it
  // nothing about what to do instead.
  if (files.length === 0) {
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      project: path.basename(root),
      root,
      composeFiles: [],
      containerised: false,
      services: [],
      warnings: [
        `No compose file in ${root} (looked for ${COMPOSE_CANDIDATES.join(", ")}).`,
        `Nothing here is containerised, so every service is runtime = "host": grove`,
        `leases a port for each and hands it back through [render] or [env].`,
        `\`adapt decide\` and \`adapt render\` have nothing to read - write`,
        `worktree.toml directly. What goes in it is one entry per hardcoded port,`,
        `which you find by reading the code: launch profiles, .env files, dev-server`,
        `config, and port literals in startup paths.`,
      ],
    };
  }

  const args = ["compose", ...files.flatMap((f) => ["-f", path.resolve(root, f)]), "config", "--format", "json"];
  const result = await exec("docker", args, { cwd: root });
  if (result.code !== 0) {
    throw new Error(
      `docker compose config failed:\n${(result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n")}`,
    );
  }

  const doc = JSON.parse(result.stdout) as {
    name?: string;
    services?: Record<string, RawService>;
  };

  const services: ServiceEvidence[] = [];
  for (const [name, raw] of Object.entries(doc.services ?? {})) {
    services.push(await readService(name, raw, warnings));
  }
  services.sort((a, b) => a.name.localeCompare(b.name));

  if (opts.probe) await probeServices(services, warnings);

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    project: doc.name ?? path.basename(root),
    root,
    composeFiles: files,
    containerised: true,
    services,
    warnings,
  };
}

interface RawService {
  image?: string;
  build?: unknown;
  ports?: { target?: number; published?: string | number; protocol?: string }[];
  expose?: (string | number)[];
  environment?: Record<string, string | null> | string[];
  depends_on?: Record<string, unknown> | string[];
  healthcheck?: { test?: string[] | string };
  volumes?: ({ source?: string; target?: string } | string)[];
}

async function readService(
  name: string,
  raw: RawService,
  warnings: string[],
): Promise<ServiceEvidence> {
  const ports: PortEvidence[] = (raw.ports ?? []).map((p) => ({
    published: p.published === undefined || p.published === "" ? null : Number(p.published),
    target: Number(p.target ?? 0),
    protocol: p.protocol ?? "tcp",
  }));

  const expose = new Set<number>((raw.expose ?? []).map((e) => Number(String(e).split("/")[0])));

  const image = raw.image ?? null;
  // The image's own EXPOSE is free evidence, and it is the only port information
  // available for a service that publishes nothing.
  if (image) for (const port of await imageExposedPorts(image)) expose.add(port);

  const environment: Record<string, string> = {};
  if (Array.isArray(raw.environment)) {
    for (const entry of raw.environment) {
      const eq = entry.indexOf("=");
      if (eq > 0) environment[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else {
    for (const [key, value] of Object.entries(raw.environment ?? {})) {
      if (value !== null) environment[key] = String(value);
    }
  }

  const dependsOn = Array.isArray(raw.depends_on)
    ? raw.depends_on
    : Object.keys(raw.depends_on ?? {});

  const test = raw.healthcheck?.test;
  const healthcheck = Array.isArray(test) ? test : typeof test === "string" ? ["CMD-SHELL", test] : null;

  const volumes = (raw.volumes ?? []).map((v) =>
    typeof v === "string" ? v : `${v.source ?? ""}:${v.target ?? ""}`,
  );

  if (ports.length === 0 && expose.size === 0 && !raw.build) {
    warnings.push(`${name}: no ports and no expose - cannot tell what it listens on`);
  }

  return {
    name,
    image,
    build: raw.build !== undefined,
    ports,
    expose: [...expose].sort((a, b) => a - b),
    environment,
    dependsOn,
    healthcheck,
    volumes,
    guess: guessKind(name, image, !!raw.build, ports, [...expose], healthcheck),
  };
}

export function guessKind(
  name: string,
  image: string | null,
  build: boolean,
  ports: PortEvidence[],
  expose: number[],
  healthcheck: string[] | null,
): ServiceEvidence["guess"] {
  const firstTarget = ports[0]?.target ?? expose[0] ?? null;

  if (image) {
    const known = KNOWN_IMAGES.find((entry) => entry.match.test(image));
    if (known) {
      return {
        kind: known.kind,
        layer: known.layer,
        port: firstTarget ?? known.port,
        evidence: `image ${image} matches a known ${known.layer} service`,
        confidence: "high",
      };
    }
  }

  // A healthcheck that curls a URL is the single most reliable signal in a
  // compose file: it names both the protocol and the health path.
  const httpProbe = healthcheck?.join(" ").match(/https?:\/\/[^\s"']+/);
  if (httpProbe) {
    return {
      kind: "http",
      layer: build ? "backend" : "infra",
      port: firstTarget,
      evidence: `healthcheck requests ${httpProbe[0]}`,
      confidence: "high",
    };
  }

  if (firstTarget === null) {
    return {
      kind: "worker",
      layer: "worker",
      port: null,
      evidence: "listens on nothing - no published port, no expose, no EXPOSE metadata",
      confidence: build ? "medium" : "low",
    };
  }

  // Name is weak evidence, used only to break a tie the ports cannot.
  const frontendish = /^(web|www|frontend|ui|client|app|next|nuxt|vite)$/.test(name);
  return {
    kind: "http",
    layer: frontendish ? "frontend" : "backend",
    port: firstTarget,
    evidence: `listens on ${firstTarget}${build ? " and is built from source" : ""}`,
    confidence: build || ports.length > 0 ? "medium" : "low",
  };
}

async function imageExposedPorts(image: string): Promise<number[]> {
  const { code, stdout } = await exec("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{json .Config.ExposedPorts}}",
  ]);
  if (code !== 0) return []; // Not pulled locally; not worth pulling for a hint.
  try {
    const parsed = JSON.parse(stdout.trim() || "null") as Record<string, unknown> | null;
    return Object.keys(parsed ?? {})
      .map((key) => Number(key.split("/")[0]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Observe rather than guess - but only where observation is cheap.
 *
 * This probes host ports the base file already publishes, which means it works
 * on a stack the user has running right now and asks nothing of them. Booting an
 * un-migrated stack ourselves is exactly the port collision this tool exists to
 * avoid, so we do not.
 */
async function probeServices(services: ServiceEvidence[], warnings: string[]): Promise<void> {
  for (const svc of services) {
    const published = svc.ports.find((p) => p.published !== null)?.published;
    if (published === null || published === undefined) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${published}/`, {
        signal: AbortSignal.timeout(2000),
        redirect: "manual",
      });
      svc.probe = { port: published, http: true, status: res.status };
    } catch {
      // A refused connection means nothing is listening; a protocol error means
      // something is, but it does not speak HTTP. Both land here, so this only
      // ever confirms HTTP - it never disproves it.
      svc.probe = { port: published, http: false, status: null };
      warnings.push(`${svc.name}: nothing answered HTTP on :${published} (is the base stack running?)`);
    }
  }
}
