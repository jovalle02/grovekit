import type { Layer } from "../../types.js";
import type { Confidence, Evidence, ServiceEvidence, ServiceKind } from "./evidence.js";

export const DECISIONS_SCHEMA_VERSION = 1;

export interface Decision {
  name: string;
  kind: ServiceKind;
  layer: Layer;
  /** Set for `http` services; becomes `<subdomain>.<slug>.<domain>`. */
  subdomain: string | null;
  /** Port the process listens on *inside* the container. */
  containerPort: number | null;
  /** Publish a leased host port - for things the proxy cannot front. */
  hostPort: boolean;
  /** An HTTP path, an exec command, a TCP connect, or null for "running is enough". */
  health: string | { exec: string[] } | { tcp: true } | null;
  /** Env vars whose values must change, keyed by var name. */
  envRewrites: Record<string, string>;
  /** Credentials the compose file already declares, for generating DATABASE_URL. */
  database?: { scheme: string; user: string; password: string; name: string };
  evidence: string;
  confidence: Confidence;
}

export interface Decisions {
  schemaVersion: number;
  project: string;
  domain: string;
  proxyPort: number;
  composeFiles: string[];
  services: Decision[];
  /** Anything a human should look at before trusting the generated files. */
  review: string[];
}

/** Read by a browser, which is not on the Docker network. See `rewriteEnv`. */
const BROWSER_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_", "NUXT_PUBLIC_", "GATSBY_", "EXPO_PUBLIC_"];

const HEALTH_EXEC: { match: RegExp; command: string[] }[] = [
  { match: /postgres/, command: ["pg_isready"] },
  { match: /mysql|mariadb/, command: ["mysqladmin", "ping", "-h", "127.0.0.1"] },
  { match: /redis|valkey/, command: ["redis-cli", "ping"] },
  { match: /mongo/, command: ["mongosh", "--quiet", "--eval", "db.runCommand('ping')"] },
];

export function isBrowserVar(name: string): boolean {
  return BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface DecideOptions {
  domain?: string;
  proxyPort?: number;
}

/**
 * Turn evidence into decisions with no model in the loop.
 *
 * This is the offline path - CI, no session, or simply a repo shaped like every
 * other repo. The model's job in the interactive path is the same shape: return
 * this structure, with `evidence` and `confidence` on every entry, and let
 * deterministic code render the YAML.
 */
export function decideHeuristically(evidence: Evidence, opts: DecideOptions = {}): Decisions {
  const review: string[] = [...evidence.warnings];

  const services = evidence.services.map((svc) => decideOne(svc, review));

  // Rewrites need every service's final port, so they are a second pass.
  for (const decision of services) {
    const svc = evidence.services.find((s) => s.name === decision.name);
    if (svc) decision.envRewrites = rewriteEnv(svc, services, opts.proxyPort ?? 8081);
  }

  if (!services.some((s) => s.layer === "frontend") && services.some((s) => s.kind === "http")) {
    review.push("no service was classified as `frontend`; BASE_URL will point at the first HTTP service");
  }

  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    project: evidence.project,
    domain: opts.domain ?? "localtest.me",
    proxyPort: opts.proxyPort ?? 8081,
    composeFiles: evidence.composeFiles,
    services,
    review,
  };
}

function decideOne(svc: ServiceEvidence, review: string[]): Decision {
  const { kind, layer, port } = svc.guess;

  // Probing beats the table, always: it is what the thing actually did.
  const probedHttp = svc.probe?.http === true;
  const finalKind: ServiceKind = probedHttp ? "http" : kind;
  const confidence: Confidence = probedHttp ? "high" : svc.guess.confidence;

  // The conservative host-port rule: if the base file published a port, the
  // author wanted to reach that thing from the host, so keep it reachable - on a
  // leased port instead of a fixed one. If they did not publish it, it stays
  // internal, because making something reachable that was not is a bigger change
  // than the migration is entitled to make.
  const wasPublished = svc.ports.some((p) => p.published !== null);
  const hostPort = finalKind !== "http" && wasPublished;

  if (finalKind === "http" && wasPublished && svc.guess.confidence !== "high") {
    review.push(
      `${svc.name}: assumed HTTP and given a URL, dropping its published port - ` +
        `if it is not HTTP, set kind to "tcp" and hostPort to true`,
    );
  }
  if (confidence === "low") {
    review.push(`${svc.name}: low confidence - ${svc.guess.evidence}`);
  }

  const database = readDatabaseCredentials(svc);

  return {
    name: svc.name,
    kind: finalKind,
    layer: finalKind === "http" ? layer : layer === "frontend" || layer === "backend" ? "data" : layer,
    subdomain: finalKind === "http" ? svc.name : null,
    containerPort: port,
    hostPort,
    health: pickHealth(svc, finalKind, hostPort),
    envRewrites: {},
    ...(database ? { database } : {}),
    evidence: svc.guess.evidence,
    confidence,
  };
}

/** Compose files carry dev credentials in plain sight; reuse them rather than guess. */
function readDatabaseCredentials(svc: ServiceEvidence): Decision["database"] | null {
  const env = svc.environment;
  if (env.POSTGRES_USER || env.POSTGRES_PASSWORD || env.POSTGRES_DB) {
    return {
      scheme: "postgres",
      user: env.POSTGRES_USER ?? "postgres",
      password: env.POSTGRES_PASSWORD ?? "postgres",
      name: env.POSTGRES_DB ?? env.POSTGRES_USER ?? "postgres",
    };
  }
  if (env.MYSQL_USER || env.MYSQL_DATABASE || env.MYSQL_ROOT_PASSWORD) {
    return {
      scheme: "mysql",
      user: env.MYSQL_USER ?? "root",
      password: env.MYSQL_PASSWORD ?? env.MYSQL_ROOT_PASSWORD ?? "",
      name: env.MYSQL_DATABASE ?? "app",
    };
  }
  return null;
}

function pickHealth(
  svc: ServiceEvidence,
  kind: ServiceKind,
  hostPort: boolean,
): Decision["health"] {
  if (kind === "http") {
    // A healthcheck that curls a path has already told us the answer.
    const url = svc.healthcheck?.join(" ").match(/https?:\/\/[^\s"']*?(\/[^\s"']*)/);
    return url?.[1] ?? "/";
  }

  const exec = HEALTH_EXEC.find((entry) => svc.image && entry.match.test(svc.image));
  if (exec) {
    // `pg_isready` without -U checks the default role, which most compose files
    // override. Use the file's own value so the check passes for the right user.
    const user = svc.environment.POSTGRES_USER ?? svc.environment.MYSQL_USER;
    if (user && exec.command[0] === "pg_isready") return { exec: [...exec.command, "-U", user] };
    return { exec: [...exec.command] };
  }

  // A TCP connect is the only check available without knowing the protocol, and
  // it needs a leased host address to connect to. With no host port there is
  // nothing left to check, so "the container is running" has to do.
  return hostPort ? { tcp: true } : null;
}

/**
 * Rewrite the URLs in a service's environment.
 *
 * The join key is the published port: `localhost:4000` in an env value, plus a
 * service publishing 4000, identifies the target unambiguously. Regex belongs on
 * env *values* - never on the YAML, which Compose has already resolved for us.
 *
 * The split that matters is who reads the value. Server-to-server URLs stay on
 * the Docker network and are byte-identical in every worktree; browser-facing
 * ones must use the external hostname, because the browser is not on that
 * network. Those are the only values that vary per worktree.
 */
export function rewriteEnv(
  svc: ServiceEvidence,
  decisions: Decision[],
  proxyPort: number,
): Record<string, string> {
  const byPort = new Map<number, Decision>();
  for (const decision of decisions) {
    if (decision.containerPort !== null) byPort.set(decision.containerPort, decision);
  }

  const out: Record<string, string> = {};
  const suffix = proxyPort === 80 ? "" : `:${proxyPort}`;

  for (const [key, value] of Object.entries(svc.environment)) {
    const match = value.match(/^(https?):\/\/([A-Za-z0-9_.-]+):(\d+)(\/.*)?$/);
    if (!match) continue;

    const [, , host = "", portText = "", pathPart = ""] = match;
    const port = Number(portText);
    const target = byPort.get(port);
    if (!target || target.name === svc.name) continue;

    // Only rewrite an address that clearly means "that other service": a loopback
    // address, or the service's own name. Anything else may be a real external
    // host that happens to share a port number.
    const looksLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/.test(host);
    if (!looksLocal && host !== target.name) continue;

    out[key] =
      isBrowserVar(key) && target.subdomain
        ? `http://${target.subdomain}.\${WT_NAME}.\${WT_DOMAIN}${suffix}${pathPart}`
        : `http://${target.name}.internal:${target.containerPort}${pathPart}`;
  }

  return out;
}
