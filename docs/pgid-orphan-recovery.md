# PGID / Orphan Process Recovery

## Three-tier kill strategy (`killTicketProcess` in `coder-runner.js:7-45`)

| Tier | Source | Mechanism |
|------|--------|-----------|
| 1. In-memory | `runningProcs` Map (same process, normal case) | `process.kill(-pid, SIGTERM)` → SIGKILL after 2s |
| 2. Database PGID | Saved `coder_pgid` on ticket (post-restart) | `process.kill(-pgid, SIGTERM)` → SIGKILL after 2s |
| 3. Session ID fallback | Saved `ocode_session` on ticket (pre-PGID-era) | `pgrep -f` by session ID, then kill each negated PID |

## Where `coder_pgid` is saved

**Only** coder sessions via `onSpawn` in `runCoder` (`coder-runner.js:66-69`). The spawn callback stores the proc in `runningProcs` AND persists `proc.pid` to the ticket's `coder_pgid` column.

`pushAndOpenPr` does NOT save its child PID to `coder_pgid` — push-phase recovery uses activity markers instead.

## Startup recovery (`recoverStuckTickets()` in `server.js:1401-1501`)

Runs as an IIFE **before** `app.listen()`. Scans all `status='running'` tickets.

### Push-phase recovery (no coder session)
- Latest activity == `pushing` → reset `status` to `idle` (user can retry)
- Latest activity == `branch_pushed` / `pr_created` / `pr_link` → finalize to `done`, release worktree, generate PR link if needed

### Coder session recovery (all other running tickets)
1. `killTicketProcess(tid, t.coder_pgid, t.ocode_session)` — kills orphan by PGID or session
2. `db.updateTicketField(tid, 'coder_pgid', null)` — clears saved PGID
3. If `ocode_session` exists AND stage == `implementation`:
   - Fire-and-forget async re-attach with `runCoder` + resume prompt
   - On success: `finishImplement` to commit and transition to `review`
   - On failure: reset `status` to `idle`
4. Otherwise: reset `status` to `idle` with descriptive log

## Gaps

1. **Recovery only on startup** — no periodic heartbeat to detect coder crash mid-run while server stays up.
2. **`coder_pgid` cleared before re-attach** (`server.js:1454`) — if server crashes again during fire-and-forget re-attach, only session-ID fallback remains.
3. **PR-tasks coder not re-attached** — falls to else branch (stage != `implementation`), resets to idle without resume.
4. **No OS-process-liveness check** — endpoints rely solely on DB `status` field. Manual corruption leaves ticket stuck returning 409 until restart.
