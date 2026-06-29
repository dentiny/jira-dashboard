# Jira Dashboard — Vision

A Jira kanban board for agentic engineers.

Single-page dashboard where you define tickets, an AI coder clarifies and implements
them, and you review the diff, run tests, and close — all locally, no cloud deps.

## Goals

- Zero-config setup for a new project: one install script, one `.env` edit
- Works with any AI coding CLI (opencode, claude code, codex, etc.)
- Runs on any OS (Linux systemd, macOS launchd, Windows schtasks)
- Fail-loud, token-aware, editor-agnostic

## Guiding Principles

**Token-aware** — every prompt sent to the AI is trimmed to essential context.
The ticket-context file pattern keeps LLM KV caches warm across tool calls.

**Fail visible** — errors stream to the UI in real time. A crashed coder call
doesn't hide behind a generic "something went wrong".

**No hidden state** — the SQLite database is the single source of truth.
Migrations are explicit, and old JSON backups can rebuild it from scratch.

**Editor agnostic** — VSCode and Cursor URIs are configurable. The dashboard
just links to your editor; it doesn't mandate one.

**User owns their data** — the SQLite database lives in your project directory.
No telemetry, no external services, no data leaves your machine.
