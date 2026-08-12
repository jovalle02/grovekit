import http from "node:http";

const PORT = 3000;
// Injected by the overlay. Identical string in every worktree - that is the point.
const API_URL = process.env.API_URL ?? "http://api.internal:4000";

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let api;
  try {
    const upstream = await fetch(API_URL, { signal: AbortSignal.timeout(2000) });
    api = await upstream.json();
  } catch (err) {
    api = { error: String(err) };
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ service: "web", worktree: process.env.WT_NAME ?? null, api }, null, 2),
  );
});

server.listen(PORT, () => console.log(`web listening on :${PORT}`));
