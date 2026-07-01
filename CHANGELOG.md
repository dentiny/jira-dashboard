# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Cutuy/jira-dashboard/releases/tag/v0.1.0