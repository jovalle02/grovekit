import { createHash } from "node:crypto";

/**
 * A slug is used simultaneously as a DNS label, a Compose project name and a
 * database name suffix, so it must satisfy the intersection of all three:
 * lowercase alphanumerics and dashes, leading alphanumeric, well under 63 chars.
 */
const MAX = 40;

export function slugify(branch: string): string {
  const s = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/, "");
  if (!s) return "grove";
  return /^[a-z0-9]/.test(s) ? s : `wt-${s}`;
}

/** Stable: the same branch always yields the same slug for the same taken-set. */
export function uniqueSlug(branch: string, taken: ReadonlySet<string>): string {
  const base = slugify(branch);
  if (!taken.has(base)) return base;
  const h = createHash("sha1").update(branch).digest("hex").slice(0, 4);
  return `${base.slice(0, MAX - 5).replace(/-+$/, "")}-${h}`;
}

/** `WT_PORT_DB`, `WT_URL_API` - the env var suffix for a service. */
export function envKey(service: string): string {
  return service.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
