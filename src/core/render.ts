import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./exec.js";

export type RenderStatus = "written" | "unchanged" | "failed";

export interface RenderedFile {
  /** Relative to the worktree root, with forward slashes. */
  file: string;
  status: RenderStatus;
  reason?: string;
}

/** `${NAME}`, the same form `[env]` templates already use. */
const PLACEHOLDER = /\$\{(\w+)\}/g;

/**
 * Substitute the worktree's environment into a template.
 *
 * An unknown variable is an error rather than an empty string. The output of
 * this is usually JSON, and `"Port": ${WT_PORT_NOPE}` silently becoming
 * `"Port": ` produces a file that fails to parse hundreds of lines away from the
 * typo that caused it.
 */
export function interpolate(
  template: string,
  env: Record<string, string>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = env[name];
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    return value;
  });
  return { text, missing: [...missing].sort() };
}

/**
 * Write the `[render]` files for this worktree.
 *
 * This is the half of `host` services that makes them worth having: a leased
 * port is useless until the process that needs it can find out what it got, and
 * these stacks already read a local config file. Rendering that file per
 * worktree is the whole integration.
 *
 * A file whose content has not changed is left alone. Rewriting it every
 * `grove status` would touch its mtime, and these paths are exactly the ones a file
 * watcher or a hot-reloading dev server is watching.
 */
export async function renderFiles(
  root: string,
  templates: Record<string, string>,
  env: Record<string, string>,
): Promise<RenderedFile[]> {
  const out: RenderedFile[] = [];

  for (const file of Object.keys(templates).sort()) {
    const template = templates[file] ?? "";
    const { text, missing } = interpolate(template, env);

    if (missing.length > 0) {
      out.push({
        file,
        status: "failed",
        reason: `no value for ${missing.map((m) => `\${${m}}`).join(", ")}`,
      });
      continue;
    }

    const dest = path.resolve(root, file);
    try {
      const current = await fs.readFile(dest, "utf8").catch(() => null);
      if (current === text) {
        out.push({ file, status: "unchanged" });
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, text, "utf8");
      out.push({ file, status: "written" });
    } catch (err) {
      out.push({ file, status: "failed", reason: (err as Error).message });
    }
  }

  return out;
}

/**
 * Whether git would ignore a path.
 *
 * A rendered file that is committed hands one worktree's ports to another the
 * next time someone checks the branch out — the same failure as a committed
 * `.wt/state.json`, and just as quiet.
 */
export async function isGitIgnored(root: string, file: string): Promise<boolean> {
  const { code } = await exec("git", ["check-ignore", "-q", "--", file], { cwd: root });
  return code === 0;
}
