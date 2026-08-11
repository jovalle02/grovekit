import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  Config,
  HealthCheck,
  HooksConfig,
  HydrateConfig,
  Layer,
  ServiceConfig,
  ServiceRuntime,
} from "../types.js";

export const CONFIG_FILENAMES = ["worktree.toml", ".worktree.toml"];

const LAYERS: Layer[] = ["frontend", "backend", "worker", "data", "infra"];

export class ConfigError extends Error {}

export async function findConfigFile(root: string): Promise<string | null> {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(root, name);
    try {
      await fs.access(file);
      return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function loadConfig(root: string): Promise<Config> {
  const file = await findConfigFile(root);
  if (!file) {
    throw new ConfigError(
      `No worktree.toml found in ${root}. Run \`wt adapt\` (or write one by hand) first.`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseToml(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`Could not parse ${file}: ${(err as Error).message}`);
  }

  const project = obj(raw.project, "project");
  const name = str(project.name, "project.name");
  const compose = project.compose === undefined ? [] : strArray(project.compose, "project.compose");

  const domainTable = raw.domain === undefined ? {} : obj(raw.domain, "domain");
  const domain = domainTable.suffix === undefined ? "localtest.me" : str(domainTable.suffix, "domain.suffix");

  const proxyTable = raw.proxy === undefined ? {} : obj(raw.proxy, "proxy");
  const proxy = {
    port: proxyTable.port === undefined ? 80 : num(proxyTable.port, "proxy.port"),
    network: proxyTable.network === undefined ? "wt-proxy" : str(proxyTable.network, "proxy.network"),
    // Traefik < 3.6 negotiates a Docker API version below 1.44 and cannot talk to
    // Docker Engine 29+ at all — it starts, serves 404s, and only the container
    // logs say why. Do not lower this default without testing against Docker 29.
    image: proxyTable.image === undefined ? "traefik:v3.6" : str(proxyTable.image, "proxy.image"),
  };

  const services = parseServices(raw.services);
  if (services.length === 0) {
    throw new ConfigError("At least one [[services]] entry is required.");
  }

  // A repo with nothing containerised is a legitimate case, and the one this
  // tool's port leasing is most useful for — an orchestrator, a `the run command`,
  // a dev server. What is not legitimate is declaring a Compose service and then
  // giving Compose no file to find it in.
  if (compose.length === 0 && services.some((s) => s.runtime === "compose")) {
    const names = services.filter((s) => s.runtime === "compose").map((s) => s.name);
    throw new ConfigError(
      `project.compose is empty, but ${names.join(", ")} ${names.length === 1 ? "is" : "are"} ` +
        `runtime = "compose". List a compose file, or mark them runtime = "host".`,
    );
  }

  const groups: Record<string, string[]> = {};
  if (raw.groups !== undefined) {
    for (const [key, value] of Object.entries(obj(raw.groups, "groups"))) {
      const members = strArray(value, `groups.${key}`);
      for (const m of members) {
        if (!services.some((s) => s.name === m)) {
          throw new ConfigError(`groups.${key} references unknown service "${m}".`);
        }
      }
      groups[key] = members;
    }
  }

  const commands: Record<string, string> = {};
  if (raw.commands !== undefined) {
    for (const [key, value] of Object.entries(obj(raw.commands, "commands"))) {
      commands[key] = str(value, `commands.${key}`);
    }
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    for (const [key, value] of Object.entries(obj(raw.env, "env"))) {
      env[key] = str(value, `env.${key}`);
    }
  }

  const healthTable = raw.health === undefined ? {} : obj(raw.health, "health");
  const healthTimeoutMs =
    healthTable.timeout_ms === undefined ? 120_000 : num(healthTable.timeout_ms, "health.timeout_ms");

  return {
    project: { name, compose },
    domain,
    proxy,
    services,
    groups,
    commands,
    env,
    healthTimeoutMs,
    hydrate: parseHydrate(raw.hydrate),
    hooks: parseHooks(raw.hooks),
    render: parseRender(raw.render),
  };
}

function parseRender(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const [file, template] of Object.entries(obj(value, "render"))) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new ConfigError(
        `render."${file}" must be a path inside the worktree — no absolute paths, no "..".`,
      );
    }
    out[file] = str(template, `render."${file}"`);
  }
  return out;
}

function parseHydrate(value: unknown): HydrateConfig {
  const empty: HydrateConfig = { copy: [], link: [], run: [], lockfiles: [] };
  if (value === undefined) return empty;
  const table = obj(value, "hydrate");
  return {
    copy: table.copy === undefined ? [] : strArray(table.copy, "hydrate.copy"),
    link: table.link === undefined ? [] : strArray(table.link, "hydrate.link"),
    run: table.run === undefined ? [] : strArray(table.run, "hydrate.run"),
    lockfiles: table.lockfiles === undefined ? [] : strArray(table.lockfiles, "hydrate.lockfiles"),
  };
}

function parseHooks(value: unknown): HooksConfig {
  // Off by default in both directions. A tool that stops your containers because
  // a chat window closed had better be something you opted into.
  const defaults: HooksConfig = { onSessionStart: "status", onSessionEnd: "off" };
  if (value === undefined) return defaults;
  const table = obj(value, "hooks");

  const start = table.on_session_start === undefined
    ? defaults.onSessionStart
    : str(table.on_session_start, "hooks.on_session_start");
  if (start !== "status" && start !== "off") {
    throw new ConfigError(`hooks.on_session_start must be "status" or "off" (got "${start}").`);
  }

  const end = table.on_session_end === undefined
    ? defaults.onSessionEnd
    : str(table.on_session_end, "hooks.on_session_end");
  if (end !== "off" && end !== "down") {
    throw new ConfigError(`hooks.on_session_end must be "off" or "down" (got "${end}").`);
  }

  return { onSessionStart: start, onSessionEnd: end };
}

function parseServices(value: unknown): ServiceConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError("[[services]] must be an array of tables.");

  const seen = new Set<string>();
  return value.map((entry, i) => {
    const svc = obj(entry, `services[${i}]`);
    const name = str(svc.name, `services[${i}].name`);
    if (seen.has(name)) throw new ConfigError(`Duplicate service "${name}".`);
    seen.add(name);

    const layerRaw = svc.layer === undefined ? "backend" : str(svc.layer, `services[${i}].layer`);
    if (!LAYERS.includes(layerRaw as Layer)) {
      throw new ConfigError(
        `services[${i}].layer must be one of ${LAYERS.join(", ")} (got "${layerRaw}").`,
      );
    }

    const runtimeRaw = svc.runtime === undefined ? "compose" : str(svc.runtime, `services[${i}].runtime`);
    if (runtimeRaw !== "compose" && runtimeRaw !== "host") {
      throw new ConfigError(
        `services[${i}].runtime must be "compose" or "host" (got "${runtimeRaw}").`,
      );
    }
    const runtime = runtimeRaw as ServiceRuntime;

    const config: ServiceConfig = {
      name,
      layer: layerRaw as Layer,
      runtime,
      health: parseHealth(svc.health, `services[${i}].health`),
    };

    if (svc.subdomain !== undefined) config.subdomain = str(svc.subdomain, `services[${i}].subdomain`);
    if (svc.port !== undefined) config.port = num(svc.port, `services[${i}].port`);
    if (svc.host_port !== undefined) config.hostPort = bool(svc.host_port, `services[${i}].host_port`);

    if (runtime === "host") {
      // A host process has no container and no Docker network, so the two things
      // the proxy needs — a route to a container, and an internal address space
      // to hide identical ports in — do not exist. All it can have is a leased
      // port, which is therefore implied rather than configured.
      config.hostPort = true;

      if (config.subdomain) {
        throw new ConfigError(
          `services[${i}] ("${name}") is runtime = "host" and cannot have a subdomain: the proxy ` +
            `routes to containers, and there is no container here. Reach it on its leased port ` +
            `instead — WT_PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}.`,
        );
      }
      if (config.port !== undefined) {
        throw new ConfigError(
          `services[${i}] ("${name}") is runtime = "host", so \`port\` has no meaning — that is the ` +
            `container port the proxy forwards to. The host port is leased, not chosen.`,
        );
      }
      if (config.health.kind === "http" || config.health.kind === "exec") {
        throw new ConfigError(
          `services[${i}] ("${name}") is runtime = "host", so health must be { tcp = true } or ` +
            `omitted. There is no container to exec in, and no proxy URL to request.`,
        );
      }
    }

    if (config.health.kind === "http" && !config.subdomain) {
      throw new ConfigError(
        `services[${i}] ("${name}") has an HTTP health path but no subdomain, so it has no ` +
          `URL to probe. Give it a subdomain, or use health = { exec = [...] }.`,
      );
    }
    if (config.health.kind === "tcp" && !config.hostPort) {
      throw new ConfigError(
        `services[${i}] ("${name}") uses a TCP health check but host_port is not set, so there ` +
          `is no host address to connect to.`,
      );
    }
    if (config.subdomain && config.port === undefined) {
      throw new ConfigError(
        `services[${i}] ("${name}") has a subdomain but no port; the proxy needs to know which ` +
          `container port to forward to.`,
      );
    }

    return config;
  });
}

function parseHealth(value: unknown, where: string): HealthCheck {
  if (value === undefined) return { kind: "none" };
  if (typeof value === "string") {
    if (!value.startsWith("/")) throw new ConfigError(`${where} must be a path starting with "/".`);
    return { kind: "http", path: value };
  }
  const table = obj(value, where);
  if (table.exec !== undefined) {
    const command = strArray(table.exec, `${where}.exec`);
    if (command.length === 0) throw new ConfigError(`${where}.exec must not be empty.`);
    return { kind: "exec", command };
  }
  if (table.tcp !== undefined) {
    return bool(table.tcp, `${where}.tcp`) ? { kind: "tcp" } : { kind: "none" };
  }
  if (table.path !== undefined) return { kind: "http", path: str(table.path, `${where}.path`) };
  throw new ConfigError(`${where} must be a path string, { exec = [...] }, or { tcp = true }.`);
}

/* ── tiny typed accessors, so config errors name the offending key ─────────── */

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`${where} must be a table.`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string.`);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${where} must be a number.`);
  }
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(`${where} must be a boolean.`);
  return v;
}

function strArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`${where} must be an array of strings.`);
  }
  return v as string[];
}
