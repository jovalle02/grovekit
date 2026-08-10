import net from "node:net";
import { createHash } from "node:crypto";
import { readJson, withLock, writeJson } from "./lock.js";
import { leasesFile } from "./paths.js";

const RANGE_START = 20_000;
const RANGE_SIZE = 4_000;

type Leases = Record<string, number>;

/**
 * Bind on 0.0.0.0, not 127.0.0.1 — that is what Docker does when publishing a
 * port, and it is strictly stronger: a loopback-only probe happily succeeds on a
 * port already held on another interface, and then `docker compose up` fails.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

/**
 * Lease a stable host port for `<slug>/<service>`.
 *
 * An existing lease is returned WITHOUT probing: our own container is holding
 * that port while the stack is up, so a liveness probe would report it busy and
 * we would pointlessly renumber on every `wt up`. Leases for dead worktrees are
 * reclaimed by `wt gc`, not here.
 */
export async function leasePort(key: string): Promise<number> {
  const file = leasesFile();
  return withLock(file, async () => {
    const leases = await readJson<Leases>(file, {});
    const existing = leases[key];
    if (existing !== undefined) return existing;

    const used = new Set(Object.values(leases));
    // Deterministic starting offset: the same worktree tends to land on the same
    // port across machines and restarts, which makes it worth bookmarking.
    const seed = parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16);

    for (let i = 0; i < RANGE_SIZE; i++) {
      const port = RANGE_START + ((seed + i) % RANGE_SIZE);
      if (used.has(port)) continue;
      if (!(await isPortFree(port))) continue;
      leases[key] = port;
      await writeJson(file, leases);
      return port;
    }
    throw new Error(
      `No free port in ${RANGE_START}-${RANGE_START + RANGE_SIZE}. Try \`wt gc\` to reclaim leases.`,
    );
  });
}

export async function releaseLeases(slug: string): Promise<string[]> {
  const file = leasesFile();
  return withLock(file, async () => {
    const leases = await readJson<Leases>(file, {});
    const prefix = `${slug}/`;
    const removed = Object.keys(leases).filter((k) => k.startsWith(prefix));
    for (const key of removed) delete leases[key];
    if (removed.length > 0) await writeJson(file, leases);
    return removed;
  });
}

export async function readLeasesFor(slug: string): Promise<Record<string, number>> {
  const leases = await readJson<Leases>(leasesFile(), {});
  const prefix = `${slug}/`;
  const out: Record<string, number> = {};
  for (const [key, port] of Object.entries(leases)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = port;
  }
  return out;
}
