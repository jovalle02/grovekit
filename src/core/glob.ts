import fs from "node:fs/promises";
import path from "node:path";

/**
 * Directories `**` never descends into. A pattern that names one explicitly, as
 * in `apps/<any>/node_modules`, still matches - this only stops a bare `**` from
 * walking a quarter-million files to find one.
 */
const PRUNE = new Set([".git", "node_modules", ".wt", "dist", ".next", "target"]);

const MAGIC = /[*?[\]]/;

export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern);
}

/** One path segment as a regex. `*` stops at the separator; `**` is handled above. */
function segmentToRegex(seg: string): RegExp {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Expand a glob against a root, returning POSIX-style relative paths that exist.
 *
 * Deliberately small: hydration patterns look like `.env` or `apps/x/.env.local`
 * with wildcards - no brace expansion, no negation. Results are sorted so a
 * hydration plan is reproducible and diffable.
 */
export async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) return [];

  const out = new Set<string>();
  await walk(root, "", normalized.split("/"), out);
  return [...out].sort();
}

async function walk(root: string, rel: string, segments: string[], out: Set<string>): Promise<void> {
  if (segments.length === 0) {
    if (rel) out.add(rel);
    return;
  }

  const [seg, ...rest] = segments;
  const here = path.join(root, rel);

  if (seg === "**") {
    // `**` matches zero segments too, so a doubled wildcard still finds `a/b`.
    await walk(root, rel, rest, out);
    for (const entry of await readdir(here)) {
      if (!entry.isDirectory() || PRUNE.has(entry.name)) continue;
      await walk(root, join(rel, entry.name), segments, out);
    }
    return;
  }

  if (seg === undefined) return;

  if (!hasMagic(seg)) {
    const child = join(rel, seg);
    if (await exists(path.join(root, child))) await walk(root, child, rest, out);
    return;
  }

  const re = segmentToRegex(seg);
  for (const entry of await readdir(here)) {
    if (re.test(entry.name)) await walk(root, join(rel, entry.name), rest, out);
  }
}

const join = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

async function readdir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
