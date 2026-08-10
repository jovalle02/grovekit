import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Config, HealthCheck, Layer, ServiceConfig } from "../types.js";

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
  const compose = strArray(project.compose, "project.compose");
  if (compose.length === 0) {
    throw new ConfigError("project.compose must list at least one compose file.");
  }

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
  };
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

    const config: ServiceConfig = {
      name,
      layer: layerRaw as Layer,
      health: parseHealth(svc.health, `services[${i}].health`),
    };

    if (svc.subdomain !== undefined) config.subdomain = str(svc.subdomain, `services[${i}].subdomain`);
    if (svc.port !== undefined) config.port = num(svc.port, `services[${i}].port`);
    if (svc.host_port !== undefined) config.hostPort = bool(svc.host_port, `services[${i}].host_port`);

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
