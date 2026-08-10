// Worktree-agnostic: every address comes from the environment `wt run` injects,
// so this exact file runs unchanged against any worktree.
const base = process.env.BASE_URL;
if (!base) {
  console.error("BASE_URL is not set — run this via `wt run node e2e.mjs`");
  process.exit(1);
}

console.log(`e2e against ${base}`);

const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
const body = await res.json();
console.log(JSON.stringify(body, null, 2));

if (!res.ok) {
  console.error(`✗ expected 2xx, got ${res.status}`);
  process.exit(1);
}
// Proves the whole chain: proxy -> web -> api.internal -> db
if (body.api?.db !== true) {
  console.error("✗ api could not reach the database");
  process.exit(1);
}
if (body.worktree !== process.env.WT_NAME) {
  console.error(`✗ served by worktree "${body.worktree}", expected "${process.env.WT_NAME}"`);
  process.exit(1);
}

console.log(`✓ e2e passed — proxy -> web -> api -> db, all inside worktree "${body.worktree}"`);
