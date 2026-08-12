import { readJson, writeJson } from "./lock.js";
import { manifestFile } from "./paths.js";
import type { Context } from "./context.js";
import type { RuntimeService } from "./health.js";
import {
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ManifestService,
  type StackStatus,
} from "../types.js";

/**
 * Top-level status is computed over the SCOPE, not over every declared service.
 * `not-started` services are excluded on purpose: they were never asked for, so
 * their absence must not make the stack look broken.
 */
export function stackStatus(services: RuntimeService[]): StackStatus {
  const inScope = services.filter((s) => s.status !== "not-started");
  if (inScope.length === 0) return "stopped";
  if (inScope.some((s) => s.status === "unhealthy")) return "unhealthy";
  if (inScope.some((s) => s.status === "starting")) return "starting";
  if (inScope.every((s) => s.status === "stopped")) return "stopped";
  if (inScope.every((s) => s.status === "ready")) return "ready";
  return "starting";
}

function toManifestService(svc: RuntimeService): ManifestService {
  const health =
    svc.config.health.kind === "http"
      ? svc.config.health.path
      : svc.config.health.kind === "none"
        ? null
        : svc.config.health.kind;

  const entry: ManifestService = {
    name: svc.config.name,
    layer: svc.config.layer,
    runtime: svc.config.runtime,
    status: svc.status,
    url: svc.url,
    internalUrl: svc.internalUrl,
    hostAddress: svc.hostAddress,
    health,
    // A host process we started has a captured log; one we merely observe has
    // nothing to show, because its output went wherever the developer ran it.
    logs:
      svc.config.runtime === "host" && !svc.config.start ? "" : `grove logs ${svc.config.name}`,
  };
  if (svc.lastLogs?.length) entry.lastLogs = svc.lastLogs;
  return entry;
}

/** Promote the two URLs most consumers want so nothing has to search the array. */
function pickPrimaryUrls(services: RuntimeService[]): { baseUrl: string | null; apiUrl: string | null } {
  const withUrl = services.filter((s) => s.url);
  const frontend = withUrl.find((s) => s.config.layer === "frontend");
  const backend = withUrl.find((s) => s.config.layer === "backend");
  return {
    baseUrl: frontend?.url ?? withUrl[0]?.url ?? null,
    apiUrl: backend?.url ?? null,
  };
}

export function buildManifest(
  ctx: Context,
  runtime: RuntimeService[],
  rendered: string[] = [],
): Manifest {
  const { baseUrl, apiUrl } = pickPrimaryUrls(runtime);

  const commands: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(ctx.config.commands)) {
    commands[name] = `grove run ${cmd}`;
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    worktree: ctx.slug,
    branch: ctx.branch,
    root: ctx.root,
    status: stackStatus(runtime),
    scope: runtime.filter((s) => s.status !== "not-started").map((s) => s.config.name),
    baseUrl,
    apiUrl,
    services: runtime.map(toManifestService),
    commands,
    rendered,
    updatedAt: new Date().toISOString(),
  };
}

/** Always written, including on failure - an agent needs to know *which* layer broke. */
export async function writeManifest(ctx: Context, manifest: Manifest): Promise<Manifest> {
  await writeJson(manifestFile(ctx.root), manifest);
  return manifest;
}

export function readManifest(root: string): Promise<Manifest | null> {
  return readJson<Manifest | null>(manifestFile(root), null);
}
