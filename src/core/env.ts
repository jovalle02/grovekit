import { envKey } from "./naming.js";
import type { Context } from "./context.js";
import type { Manifest } from "../types.js";

/**
 * The environment this worktree exposes.
 *
 * One definition, three consumers: `wt run` injects it into the child, `wt status
 * --env` prints it, and `[render]` interpolates templates against it. It lives in
 * core rather than next to `run` so that `up` can render files without importing
 * a command module that imports it back.
 */
export function buildEnv(ctx: Context, manifest: Manifest): Record<string, string> {
  const env: Record<string, string> = {
    WT_NAME: ctx.slug,
    WT_BRANCH: ctx.branch,
    WT_ROOT: ctx.root,
    WT_DOMAIN: ctx.config.domain,
  };

  if (manifest.baseUrl) env.BASE_URL = manifest.baseUrl;
  if (manifest.apiUrl) env.API_URL = manifest.apiUrl;

  for (const svc of manifest.services) {
    const key = envKey(svc.name);
    if (svc.url) env[`WT_URL_${key}`] = svc.url;
    if (svc.hostAddress) {
      env[`WT_HOST_${key}`] = svc.hostAddress;
      const port = svc.hostAddress.split(":").pop();
      if (port) env[`WT_PORT_${key}`] = port;
    }
  }

  // User-declared templates, interpolated against everything above.
  for (const [key, template] of Object.entries(ctx.config.env)) {
    env[key] = template.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? "");
  }

  return env;
}
