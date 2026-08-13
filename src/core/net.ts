import net from "node:net";

/**
 * Two ways to ask whether a port is taken, kept in one file because they have to
 * agree.
 *
 * They did not. Leasing asked "can I bind 0.0.0.0?" and the guard in `up` asked
 * "does anything answer on loopback?" - different questions, and on a port held
 * by an IPv6-only listener they give different answers. So a worktree could be
 * handed a port that the very next check declared occupied by a stranger, and
 * the user was told to hunt an orphan the tool had just walked into.
 */

const PROBE_TIMEOUT_MS = 1_000;

function connectTo(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Whether anything answers on this port.
 *
 * Both loopback families, because a server that binds `::` on a dual-stack host
 * and one that binds `127.0.0.1` are equally real and only one of them answers
 * an IPv4 probe.
 */
export function tcpReachable(port: number): Promise<boolean> {
  return Promise.all([connectTo(port, "127.0.0.1"), connectTo(port, "::1")]).then((r) =>
    r.some(Boolean),
  );
}

/**
 * Whether this process can bind the port on `host`.
 *
 * A family the machine does not support is not a conflict: a host with IPv6
 * disabled fails to bind `::` for a reason that has nothing to do with the port
 * being taken, and treating that as "busy" would reject every port on the
 * machine. Only a refusal that names a conflict counts.
 */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      const conflict = err.code === "EADDRINUSE" || err.code === "EACCES";
      resolve(!conflict);
    });
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Whether a port is free enough to lease.
 *
 * Deliberately the strictest of the available questions: binding must succeed on
 * both wildcard addresses *and* nothing may answer on loopback. Being wrong in
 * the cautious direction costs one port out of four thousand; being wrong the
 * other way hands a worktree an address that is already somebody's.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ["0.0.0.0", "::"]) {
    if (!(await canBind(port, host))) return false;
  }
  return !(await tcpReachable(port));
}
