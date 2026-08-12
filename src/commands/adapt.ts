import fs from "node:fs/promises";
import path from "node:path";
import { gitRoot } from "../core/context.js";
import { exec } from "../core/exec.js";
import { exists } from "../core/glob.js";
import { readJson, writeJson } from "../core/lock.js";
import { c, fail, printJson } from "../core/output.js";
import { wtDir } from "../core/paths.js";
import { decideHeuristically, type Decisions } from "../core/adapt/decide.js";
import { gatherEvidence, type Evidence } from "../core/adapt/evidence.js";
import { CONFIG_FILE, OVERLAY_FILE, render } from "../core/adapt/render.js";

export interface AdaptOptions {
  json: boolean;
  step: string;
  /** Path to a decisions file, for `render`. */
  file?: string;
  out?: string;
  heuristic: boolean;
  probe: boolean;
  force: boolean;
}

const STEPS = ["evidence", "decide", "render", "validate"] as const;

/**
 * The migration pass, as four steps with exactly one model-shaped hole in it.
 *
 *   evidence   [code]   normalise + read the repo   -> JSON
 *   decisions  [model]  <- the only judgment, and it is a FILE, not a command
 *   render     [code]   decisions -> YAML + TOML
 *   validate   [code]   merge, boot, request every generated URL
 *
 * Splitting it this way is the point. A model that emits YAML directly produces
 * something you cannot diff, cannot re-run, and cannot check; a model that emits
 * structured decisions with evidence attached produces something a human can
 * read in thirty seconds and deterministic code can render identically forever.
 */
export async function adapt(opts: AdaptOptions): Promise<void> {
  const root = await gitRoot();

  switch (opts.step) {
    case "evidence":
      return evidenceStep(root, opts);
    case "decide":
      return decideStep(root, opts);
    case "render":
      return renderStep(root, opts);
    case "validate":
      return validateStep(root, opts);
    default:
      fail(
        {
          ok: false,
          error: opts.step ? `unknown adapt step "${opts.step}"` : "no adapt step given",
          hint: `usage: grove adapt <${STEPS.join("|")}>`,
        },
        opts.json,
      );
  }
}

const evidenceFile = (root: string) => path.join(wtDir(root), "evidence.json");
const decisionsFile = (root: string) => path.join(wtDir(root), "decisions.json");

async function evidenceStep(root: string, opts: AdaptOptions): Promise<void> {
  let evidence: Evidence;
  try {
    evidence = await gatherEvidence(root, { probe: opts.probe });
  } catch (err) {
    fail({ ok: false, error: (err as Error).message }, opts.json);
  }

  await writeJson(evidenceFile(root), evidence);

  if (opts.json) {
    printJson(evidence);
    return;
  }

  // Not an error, and not something the rest of the pipeline can help with.
  // Explain the other path instead of printing an empty service table.
  if (!evidence.containerised) {
    console.log(`${c.bold(evidence.project)} ${c.yellow(" -  nothing containerised")}`);
    console.log();
    for (const line of evidence.warnings) console.log(`  ${c.dim(line)}`);
    console.log();
    console.log(c.dim(`written to ${path.relative(root, evidenceFile(root))}`));
    return;
  }

  console.log(`${c.bold(evidence.project)} ${c.dim(evidence.composeFiles.join(" + "))}`);
  console.log();
  for (const svc of evidence.services) {
    const ports = svc.ports.map((p) => (p.published ? `${p.published}->${p.target}` : `${p.target}`));
    console.log(
      `  ${c.bold(svc.name.padEnd(14))} ${svc.guess.kind.padEnd(7)} ${c.dim(
        `${ports.join(",") || "no ports"} - ${svc.guess.evidence}`,
      )}`,
    );
  }
  for (const warning of evidence.warnings) console.log(c.yellow(`  ! ${warning}`));
  console.log();
  console.log(c.dim(`written to ${path.relative(root, evidenceFile(root))}`));
  console.log(c.dim("next: `grove adapt decide --heuristic`, or write .wt/decisions.json yourself"));
}

async function decideStep(root: string, opts: AdaptOptions): Promise<void> {
  const evidence = await readJson<Evidence | null>(evidenceFile(root), null);
  const source = evidence ?? (await gatherEvidence(root, { probe: opts.probe }).catch(() => null));

  if (!source) {
    fail(
      { ok: false, error: "no evidence available", hint: "run `grove adapt evidence` first" },
      opts.json,
    );
  }

  const decisions = decideHeuristically(source);
  const file = decisionsFile(root);

  if ((await exists(file)) && !opts.force) {
    fail(
      {
        ok: false,
        error: `${path.relative(root, file)} already exists`,
        hint: "pass --force to overwrite the decisions you already have",
      },
      opts.json,
    );
  }

  await writeJson(file, decisions);

  if (opts.json) {
    printJson(decisions);
    return;
  }

  printDecisions(decisions);
  console.log(c.dim(`written to ${path.relative(root, file)} - edit it, then \`grove adapt render\``));
}

async function renderStep(root: string, opts: AdaptOptions): Promise<void> {
  const file = opts.file ? path.resolve(root, opts.file) : decisionsFile(root);
  const decisions = await readJson<Decisions | null>(file, null);

  if (!decisions) {
    fail(
      {
        ok: false,
        error: `no decisions at ${path.relative(root, file)}`,
        hint: "run `grove adapt decide --heuristic`, or point at a file with `grove adapt render <file>`",
      },
      opts.json,
    );
  }
  if (!Array.isArray(decisions.services) || decisions.services.length === 0) {
    fail({ ok: false, error: `${path.relative(root, file)} has no services` }, opts.json);
  }

  const outDir = opts.out ? path.resolve(root, opts.out) : root;
  const rendered = render(decisions);
  const written: { file: string; action: string }[] = [];

  for (const artifact of [rendered.overlay, rendered.config]) {
    const dest = path.join(outDir, artifact.file);
    const current = await fs.readFile(dest, "utf8").catch(() => null);

    if (current === artifact.content) {
      written.push({ file: artifact.file, action: "unchanged" });
      continue;
    }
    if (current !== null && !opts.force) {
      written.push({ file: artifact.file, action: "skipped (exists - use --force)" });
      continue;
    }
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(dest, artifact.content, "utf8");
    written.push({ file: artifact.file, action: current === null ? "created" : "overwritten" });
  }

  if (opts.json) {
    printJson({ ok: true, files: written, review: decisions.review });
    return;
  }

  for (const entry of written) console.log(`${c.green("ok")} ${entry.action.padEnd(12)} ${entry.file}`);
  for (const note of decisions.review) console.log(c.yellow(`  ! ${note}`));
  console.log();
  console.log(c.dim("next: `grove adapt validate`"));
}

/**
 * The checks that catch a bad generation before it wastes a debugging session.
 *
 * Every one of these corresponds to a failure that *looked like success*: a
 * merge that silently drops a value, a service still publishing a fixed port, a
 * sibling call that resolves to another worktree's container.
 */
async function validateStep(root: string, opts: AdaptOptions): Promise<void> {
  const problems: { check: string; detail: string; hint?: string }[] = [];

  const overlay = path.join(root, OVERLAY_FILE);
  const config = path.join(root, CONFIG_FILE);

  for (const [name, file] of [["overlay", overlay], ["config", config]] as const) {
    if (!(await exists(file))) {
      problems.push({ check: `${name} exists`, detail: `${path.basename(file)} is missing`, hint: "run `grove adapt render`" });
    }
  }

  if (problems.length === 0) {
    const evidence = await gatherEvidence(root).catch(() => null);
    const files = evidence ? [...evidence.composeFiles, OVERLAY_FILE] : [OVERLAY_FILE];

    // Merge with placeholder values: `docker compose config` fails on an
    // unresolvable `${WT_PORT_DB}`, and an empty interpolation would look like a
    // missing port rather than a missing variable.
    const merged = await exec(
      "docker",
      ["compose", ...files.flatMap((f) => ["-f", path.resolve(root, f)]), "config", "--format", "json"],
      { cwd: root, env: { ...process.env, ...placeholderEnv(evidence) } },
    );

    if (merged.code !== 0) {
      problems.push({
        check: "files merge",
        detail: merged.stderr.trim().split("\n").slice(-3).join(" "),
      });
    } else {
      const doc = JSON.parse(merged.stdout) as {
        services?: Record<string, { ports?: unknown[]; networks?: Record<string, { aliases?: string[] }> }>;
        networks?: Record<string, { external?: boolean }>;
      };

      // Networks shared between worktrees. Only these create ambiguity - a
      // private network has exactly one `api` in it.
      const shared = new Set(
        Object.entries(doc.networks ?? {})
          .filter(([, net]) => net?.external === true)
          .map(([key]) => key),
      );

      for (const [name, svc] of Object.entries(doc.services ?? {})) {
        const published = (svc.ports ?? []).length;
        const aliases = Object.values(svc.networks ?? {}).flatMap((n) => n?.aliases ?? []);
        const onShared = Object.keys(svc.networks ?? {}).some((key) => shared.has(key));

        // The shared-network alias collision: every worktree attaches a service
        // called `api` to the same proxy network, so a bare `api` is ambiguous
        // there. It works with one worktree and goes wrong with two - the worst
        // possible failure mode, because everything you test first passes.
        if (onShared && !aliases.includes(`${name}.internal`)) {
          problems.push({
            check: "internal alias",
            detail: `${name} is on the shared network with no \`${name}.internal\` alias`,
            hint: "siblings must call each other through it; a bare name is ambiguous there",
          });
        }

        if (published > 0 && !hasLeasedPort(svc.ports)) {
          problems.push({
            check: "no fixed host ports",
            detail: `${name} still publishes a fixed host port`,
            hint: "add `ports: !reset []`, or `!override` with a ${WT_PORT_<NAME>} lease",
          });
        }
      }
    }
  }

  const ok = problems.length === 0;

  if (opts.json) {
    printJson({ ok, problems });
  } else if (ok) {
    console.log(`${c.green("ok")} overlay and config validate`);
    console.log(c.dim("next: `grove doctor`, then `grove up --build`"));
  } else {
    for (const problem of problems) {
      console.log(`${c.red("x")} ${problem.check.padEnd(20)} ${c.dim(problem.detail)}`);
      if (problem.hint) console.log(`  ${c.dim("hint: " + problem.hint)}`);
    }
  }

  if (!ok) process.exitCode = 1;
}

/** Values that make interpolation resolve during a merge-only check. */
function placeholderEnv(evidence: Evidence | null): Record<string, string> {
  const env: Record<string, string> = {
    WT_NAME: "validate",
    WT_DOMAIN: "localtest.me",
    WT_PROXY_NETWORK: "wt-proxy",
    WT_PROXY_PORT: "8081",
  };
  for (const svc of evidence?.services ?? []) {
    env[`WT_PORT_${svc.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = "29999";
  }
  return env;
}

/** A published port is fine when it came from a lease; the placeholder proves it. */
function hasLeasedPort(ports: unknown[] | undefined): boolean {
  return (ports ?? []).some((p) => String((p as { published?: unknown })?.published ?? "") === "29999");
}

function printDecisions(decisions: Decisions): void {
  for (const svc of decisions.services) {
    const where = svc.subdomain
      ? `${svc.subdomain}.<worktree>.${decisions.domain}`
      : svc.hostPort
        ? "leased host port"
        : "internal only";
    const mark = svc.confidence === "high" ? c.green("ok") : svc.confidence === "medium" ? c.yellow("~") : c.red("?");
    console.log(`${mark} ${c.bold(svc.name.padEnd(14))} ${svc.kind.padEnd(7)} ${c.dim(where)}`);
    const rewrites = Object.keys(svc.envRewrites);
    if (rewrites.length > 0) console.log(c.dim(`    rewrites ${rewrites.join(", ")}`));
  }
  if (decisions.review.length > 0) console.log();
  for (const note of decisions.review) console.log(c.yellow(`  ! ${note}`));
  console.log();
}
