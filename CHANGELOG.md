# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-09

The "PR lifecycle, end to end" release. A new `pr_opened` stage sits between
Review and Done, the dashboard periodically polls GitHub for new failures or
comments, and an inline "Address PR" action spins up a gh-scoped coder pass
to deal with both check failures and review threads without leaving the
board. Underneath, this release also delivers the cost/token visibility and
crash-recovery plumbing that lets the dashboard run unattended for a full
workday.

97 commits since `v0.2.0`. The "What's next" roadmap at the bottom of the
v0.2.0 release page (rename to `idea-to-pr`, `docs/vs-*` comparison pages,
awesome-* submissions, Show HN draft) is **still on deck** and intentionally
not included here — those are marketing/positioning work, not the runtime
work this release ships.

### Added

- **PR lifecycle end to end.** New `pr_opened` stage between Review and Done.
  Tickets that should ship through a PR now flow Backlog → Clarification →
  Implementation → Review → PR opened → Done, with the Done row reserved for
  closed/merged tickets. (`f64ac79`, `f7bc6ae`, `09365bf`, `2ee893f`,
  `f09f5f4`)
- **Periodic PR checker** (`pr-checker.js`, ~246 lines). Polls every
  configured ticket's PR for state changes, new check failures, and new
  comments. On a new failure it auto-moves the ticket back to Clarification
  and forces a fresh clarification round so the coder sees the gate
  context. (`d759772`, `21a37c7`, `e358940`, `c4cba4d`, `6f81e72`,
  `019ace4`, `98261cd`, `9086e7a`, `b761b3c`, `2a3745b`)
- **Address PR button.** Inline action that runs the coder with a gh-only
  scope (no code edits) and writes structured `{ rework_checks,
  touched_checks, resolved_comments }` back to the server. Disabled when
  there's nothing to address. (`8cc37b6`, `8801c4a`, `56db21a`,
  `99ac56a`, `0f11c88`, new `pr-tasks-input.schema.json` +
  `pr-rework.schema.json`, `d4e13bc`, `4771df3`, `3edb4f9`, `0c75a9f`,
  `0bc0ba6`)
- **PR Review Comments split.** Issue-level comments (`pr.comments`) and
  unresolved inline review threads (`reviewThreads` where `isResolved ==
  false`) are now two separate virtual checks. The coder handles each
  per-item: flag for rework, or close the thread via `gh api graphql` with
  an optional reply. (`64c9b78`, `95d4118`, `5297eb4`, `0634486`)
- **Per-ticket token and cost tracking.** Per-run cost and tokens stream
  live to the implementation card for opencode, Claude, and Codex.
  Accumulates across events, never goes negative, persists across ticket
  resets. Replaces the old global singleton that lost data as soon as a
  second ticket started. Spread across the three backends
  (`coder/claude.js`, `coder/codex.js`, `coder/opencode.js`) plus the
  live-cost UI in `client/src/App.tsx` — see commits `a802eca`, `798d98b`,
  `4c12f88`, `fee042c`, `be5c383`, `72b21ed`, `40ce2a1`, `c3cb2b6`,
  `ae9b3f7`, `175cf51`, `37681aa`, `44e4094`, `2f21573`.
- **Crash and orphan recovery.** On startup, the dashboard kills any
  orphaned coder process group (`pgid`) and re-attaches the session back
  into the UI. Cleans up both by PID and by session ID. Documented in
  `docs/pgid-orphan-recovery.md`. (`175cf51`, `1dddba4`, `ae9b3f7`,
  `b0187da`, `fde3b7c` for the related auto-clarify path)
- **Machine checks on startup** (`machine-checks.js`, ~67 lines; new
  surfaces unconfigured bits (no project repo, no coder CLI on PATH, port
  conflict) the same way the rest of the dashboard surfaces state, so a
  cold start tells you what's wrong in two seconds instead of silently
  failing later. file). Commits `2bb10b6`, `6a02a9f`, `ca7e8fb`.
- **Restart Server button.** New "Restart Server" card action + `/api/restart`
  endpoint. Restarts the systemd / launchd service from the UI — no SSH
  required. (commit `d0baf0f`, new `/api/restart` endpoint)
- **Generic test runner with `command_override`.** `test-runner.js` replaces
  the old Python-only `python -m project.test` assumption. Set
  `test.command_override` in `config.json` (or per-project `.env`) to run
  any language's test command with the right timeout. Defaults preserved
  for existing Python projects. (commit `f35ad68`, new `test-runner.js`)
- **`pr_tasks_only` column on tickets.** Replaces the old
  `clarification`/`feedback` string-prefix hack. Lets the dashboard know
  whether a round of clarification was triggered by PR feedback (so the
  Address PR flow can ignore non-actionable process gates) without mixing
  it into the regular clarification text. (`0f11c88`, `019ace4`)
- **Race guard in pr-checker + line-buffered stdout streaming.**
  Checker no longer double-fires when a long poll overlaps a fresh push,
  and coder stdout now streams to the UI line by line instead of in
  chunked bursts. (`98d59d5`)
- **UI: ticket popup edits.** Renders `touched_checks` results inline,
  renders resource usage from the per-stage bucket array (not deltas),
  disables Address PR when there's nothing to address, shows live cost
  + tokens per run. (`f9c507f`, `client/src/App.tsx`)
- **Schema-validated Address PR output.** Coder writes `JSON` to a file;
  server validates with `ajv` against the new `pr-rework.schema.json`
  + `pr-tasks-input.schema.json`. Garbage output throws instead of being
  stored. (`e9b2fe2`, `017715b`, `c2bceb3`, `852def2`)
- **PR-specific clarify prompt.** When the coder is asked to clarify a
  PR-feedback round, it gets `clarifyPR` — the same schema + file format
  as a regular clarify round but with a prompt that tells it not to
  re-ask implementation questions. (`083e1cb`, `d1099e8`)
- **Configurable per-project ignore lists.** `config.prCheckIgnore` and
  `config.commentIgnoreAuthors` are now arrays you can edit per project
  to skip a known-noisy check or bot commenter. (`e358940`, `c0f789a`)
- **PR-status-pill on the ticket card.** Uses the same green/purple/red
  conventions as GitHub itself for open / merged / closed. (UI commit
  `09365bf`; underlying state machinery in `pr-checker.js`)

### Changed

- **`server.js` shrunk by ~1117 lines.** Extracted into `pr-checker.js`,
  `machine-checks.js`, `test-runner.js`, `coder-runner.js`, `git-utils.js`,
  `helpers.js`, `context.js`, `sse.js`. The original "kitchen sink"
  `server.js` is now a thin HTTP layer over real modules.
- **Worktree pool ops are now async.** No longer blocks the Node event loop
  on `git worktree add` in large repos. Stale `index.lock` files are
  reclaimed cleanly with explicit tests. (`4b05bc6`, `16e784c`,
  `tests/worktree-pool.test.js`)
- **Test runner replaced.** `test-runner.js` is the new entry point; old
  inline Python call removed.
- **Token / cost attribution now per ticket.** Removed the global singleton
  store; each ticket owns its own accumulator. (`2f21573`)
- **PR creation in ready handler.** When a ticket uses PR merge strategy,
  branch is force-pushed, base SHA is recorded at worktree acquire time,
  and existing `pr_url` is reused — no double-PRs. (`a4cc9d4`,
  `ccfa761`, `0af0572`, `075d51b`, `40a2fc1`)
- **Markdown tip line in UI.** The "Tip" hint that the implementation
  card now shows references `gh api graphql` directly when there are open
  review threads, so the coder doesn't waste a round figuring out the
  query. (`95d4118`)
- **Cost attribution in claude backend.** Per-message tokens now accumulate
  across `result` events into the run total instead of snapshot-delta math.
  (`798d98b`, `4c12f88`, `fee042c`, `be5c383`, `72b21ed`,
  `40ce2a1`, `c3cb2b6`)
- **Auto-attach orphan recovery** (`worktree-manager.js`). Worktree state
  preserved across the recovery cycle; the worktree stays the same and the
  coder session is re-anchored to it.

### Fixed

- **PR review thread handling on a closed PR** was racing and losing state —
  now serialized via `pr-checker.js` locks. (`98d59d5`)
- **Crash recovery did not re-attach coder sessions** by session ID — only
  by PID. Now both paths are covered. (`1dddba4`)
- **`index.lock` left in `.worktrees/pool-N/`** if a crashed ticket left
  one behind. New reclaim pass ensures the next ticket gets a clean slot.
  (`16e784c`)
- **Negative token display** on claude / codex backends after a crash —
  fixed by per-ticket accumulator instead of delta-of-snapshot. (`37681aa`)
- **Lost cost on ticket reset.** Resetting a ticket used to zero the
  global accumulator, polluting the next ticket. Per-ticket storage now
  survives the reset. (`44e4094`)
- **Coder ran in the wrong directory.** PR checker now launches coder in
  the worktree directory, not the main checkout. (`8157a05`)
- **Mid-session PRs not registered with the checker** when the coder
  `gh pr create`s itself. Now registered as soon as the URL is detected.
  (`8157a05`)
- **formatPlanText dumped raw JSON** when the underlying format was
  ambiguous. Now extracts `text`, `body`, or `message` field from any of
  the supported wrappers. (`72ca882`)
- **`worktree-manager` cleared `commit_sha` and `pr_url` on close.** It
  no longer does — close ≠ merge. (`a00ce29`)
- **JSX rendered literal `'0'`** from a falsy `pr_tasks_only`. Fixed.
  (`9086e7a`)
- **`gh pr create` sometimes failed on pre-existing branches** — now
  reuses an existing PR URL when present. (`ccfa761`)

### Test coverage added

- `tests/pr-checker.test.js` (new file) — checker lifecycle, stale lock
  reclaim, auto-clarify path.
- `tests/worktree-pool.test.js` — +217 lines covering stale `index.lock`
  reclamation, fresh-base-fallback, dirty-worktree reclaim.
- `tests/server-helpers.test.js` — +162 lines for the new Address PR
  parsing paths, cost accumulator math, schema validation.
- `tests/prompts.test.js` — covers `prTasks` content and `check-line`
  regex parsing.
- `tests/coder.test.js` — auto-detect type from binary name; updated
  claude backend tests.
- **Pre-push hook runs all 8 suites** (was 7).

### Migration

No data migration. Existing tickets, worktrees, and `.jira-dashboard/.env`
config are untouched. Pull, restart the service (the new "Restart Server"
button does this in one click), done.

## [0.2.0] — 2026-07-02

The "Claude is a first-class backend" release. Validated end-to-end against
a fresh machine with Claude Code installed, and added the test coverage to
keep it that way.

### Added

- **Validated Claude Code backend.** Confirmed the claude CLI uses `--output-format`
  (not `--format`); `coder/claude.js` now emits the correct flags end-to-end and
  parses `stream-json` events back into the dashboard's live progress stream.
  Resume via `-r <sessionId>` is supported. (-PR: `34cbbec`)
- **Auto-detection of coder type from binary name.** When `JIRA_CODER_TYPE`
  is left at the default `opencode` (the common case), the dashboard now
  inspects `JIRA_CODER_BIN` and selects the matching backend automatically —
  `bin=claude` → claude, `bin=codex` → codex, otherwise opencode. Closes the
  "claude was being fed opencode flags" gap that surfaced when cloning the
  repo to a machine whose only AI CLI is Claude. (PR: `3b2e288`)

### Fixed

- **Implement / ready endpoints no longer touch the user's main checkout.**
  Replaced the buggy `git checkout -b` + `git checkout <default>` dance in
  the implementation setup with `git worktree add -b` (one command, pure
  metadata) and replaced the ready/close flow's `git checkout <default> &&
  git cherry-pick` with `git update-ref refs/heads/<default> <sha>`
  (plumbing-only, never touches the working tree). Users with uncommitted
  local changes in their main checkout no longer get
  "your local changes would be overwritten" errors when starting a ticket
  or closing one. (PR: `324a846`)

### Test coverage added

- `tests/coder.test.js` — 4 new claude backend tests (buildArgs flags pinned
  to `--output-format`/`--verbose`, formatProgress, parseOutput,
  parseOutput fallback) + 4 auto-detection tests.
- `tests/git-workflow.test.js` (new file) — 3 integration tests that spin
  up a real temp git repo, simulate uncommitted user changes, and assert the
  user's working tree files are byte-identical before and after each
  dashboard git operation.

## [0.1.0] — 2026-07-01

The first public release. Dogfooded on the jira-dashboard repo itself.

### Added

- **Kanban board** with five stages: Backlog → Clarification → Implementation → Review → Done
- **Agent-driven clarification loop** — the coder backend asks structured questions, you answer inline in the ticket popup
- **Worktree-isolated implementation** — every ticket gets its own git worktree, so the agent can't stomp on your WIP
- **Live progress streaming** — implementation card shows the agent's output as it runs, not just on completion
- **Inline review** — branch diff and test output on the same screen as the implementation; feedback goes straight back to the agent
- **Cherry-pick close** — closing a ticket cherry-picks the worktree's branch onto your default branch, with explicit conflict guidance
- **Coder backend abstraction** — single file per backend under `coder/`. opencode is the default; claude code and codex are stubs ready to fill in
- **Install script** — interactive `bootstrap.sh` + systemd (Linux) / launchd (macOS) service install with port auto-detection
- **Project-level config** — `<project>/.env` is auto-loaded into the coder subprocess; `<project>/.jira-dashboard/.env` holds dashboard settings
- **Self-tracking mode** — point the dashboard at its own repo and use it to manage itself
- **Pre-push hook** — `.githooks/pre-push` runs the dashboard's pre-push pipeline before any push
- **Mobile-responsive UI** — same board on phone, single-column flow, ticket popup full-screen

### Known limits

- Linux-only resource monitor (`/proc/<pid>/stat`). macOS falls back to `ps`, less granular
- Test runner assumes Python (`python -m project.test`). Other languages need a custom command in `config.json`
- Coder backends other than opencode are stubs

See [`docs/todo.md`](docs/todo.md) for the full roadmap.

[0.3.0]: https://github.com/Cutuy/jira-dashboard/releases/tag/v0.3.0
[0.2.0]: https://github.com/Cutuy/jira-dashboard/releases/tag/v0.2.0
[0.1.0]: https://github.com/Cutuy/jira-dashboard/releases/tag/v0.1.0