# Verify: prove the grove, not the tree

Reference for the verification steps of `/setup-grove`. Discovery read the code;
this finds out what is true.

**One tree is not a grove.** A single stack booting green is the state the repo
was already in before grove existed - it proves nothing about the thing grove is
for. Setup is finished when two worktrees serve at the same time, and not
before.

## 1. The audit: what did each process actually bind?

Boot once, then compare the **leased** ports against the **live** listeners. Do
this before writing any conclusion about which ports work - it is the only step
that produces facts rather than inferences, and it takes under a minute.

```
grove up
grove status --json          # what grove leased, and what it can see
```

Then list every listener on the machine with its owning process:

| Platform | Command |
|---|---|
| Windows | `Get-NetTCPConnection -State Listen \| Select LocalPort,OwningProcess` |
| Linux | `ss -ltnp` |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` |

For each service, one of three outcomes:

- **On its lease** - honoured. Record it.
- **On the port discovery found as its default** - the lease is ignored. This
  service collides with every other worktree. Blocker.
- **Nowhere** - it never started. Go to the stuck protocol below; a service that
  is absent is a different problem from one on the wrong port.

`grove status` reports a service as `not running` when its lease is unbound - it
does not know something else answered on the old port. The listener list is what
distinguishes "ignored the lease" from "did not start", and those need opposite
fixes.

## 2. Blocker gate: stop and ask, here

If the audit found services that ignore their leases, or discovery found
`movable: "no"` findings, **report to the user now and wait**. Do not carry on
to the final report.

Setup at this point is **blocked**, not finished - say that word. A summary that
lists what works and buries what does not reads as success, and the missing half
surfaces days later as a port collision nobody connects to setup.

Give them, per service: what it binds, what it should bind, and the **smallest
change** that would make it configurable, in the idiom the surrounding code
already uses. Then ask whether to make those changes.

Source changes are the user's call. Make the config work as far as config can
reach, and put the rest in front of them as a decision.

## 3. The grove test

Two worktrees, both serving. Commit `worktree.toml` first - a new worktree gets
the branch's files, so an uncommitted config means the worktree arrives without
one and `grove new` rolls back.

```
git add worktree.toml .gitignore && git commit
grove new feat/grove-check
```

Pass condition, all four:

1. Both stacks reach `ready`.
2. Their ports are disjoint - compare `grove ls --all --json`.
3. Each **serves**, not merely listens: request a real endpoint on each and read
   the response. A listening socket that returns 500 is not a working stack.
4. The second stack's URLs resolve to the second stack. Fetch something
   identifying - a health endpoint naming the branch, a database row - and
   confirm the two answers differ. Two worktrees can both appear up while one
   proxies to the other's backend.

Then `grove rm feat-grove-check --delete-branch`.

Only report the grove test as passed when you ran it. Predicting the outcome
from the audit is sound reasoning and is not the same claim - if you skip the
run, say you skipped it and why, in those words.

**Teardown on Windows:** `[hydrate] link` entries are junctions, and
`git worktree remove` fails on them. `grove rm --force` drops the registry entry
and leaves the directory. Remove the junction entries themselves before deleting
the directory - a recursive delete follows them into the main worktree and takes
its `node_modules` with it. Verify the originals survived.

## 4. Stuck protocol: a dead wait looks exactly like a slow build

A parent process stays alive when its child crashes. The stack sits at
`starting` forever, the log shows a build that never finishes, and nothing
reports an error - because the parent has not failed.

**Stop waiting when a boot passes its timeout, or two minutes pass with no state
change.** Then go and find the corpse:

- The orchestrator's **per-child** logs, which are not the parent's stdout.
  Aspire writes them under a temp `aspire-dcp*` directory; docker compose keeps
  them per container; PM2 and supervisord write per-process files. `grove logs
  <service>` when grove owns the process.
- The child's stderr specifically. A crash-on-startup writes there and nowhere
  else.
- Whether a dependency gate is holding everything: one service failing behind a
  `depends_on` / `WaitFor` chain leaves every downstream service in `starting`
  with no error of its own.

Re-check the same condition once. If it has not moved, **tell the user what you
found** rather than waiting again. Two identical waits on one condition is the
loop to break - the second adds no information, and the user is watching a
spinner that will never resolve.

Environment failures are worth reporting fast and are not yours to fix: an
unreachable database host, an expired credential, a VPN that is down. Name the
host and the error and ask.
