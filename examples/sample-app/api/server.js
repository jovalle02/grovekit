import http from "node:http";
import net from "node:net";

const PORT = 4000;
const DB_HOST = process.env.DB_HOST ?? "db";
const DB_PORT = Number(process.env.DB_PORT ?? 5432);

/** Raw TCP check, so the image needs no dependencies and builds instantly. */
function dbReachable() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(DB_PORT, DB_HOST);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      service: "api",
      worktree: process.env.WT_NAME ?? null,
      db: await dbReachable(),
    }),
  );
});

server.listen(PORT, () => console.log(`api listening on :${PORT}`));
