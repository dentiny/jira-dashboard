# Project Vision

A lightweight, self-hosted ticket dashboard for AI-assisted development workflows.
Define tickets, let AI clarify and implement them, review diffs, run tests — all from
a single-page dashboard with zero external service dependencies.

## Goals

- **Simple setup** — one `npm install && npm start` gets you a working dashboard.
  No database servers, no cloud accounts, no Jira license.
- **Tight AI integration** — tickets flow through clarification → implementation →
  review → done with minimal manual toil. The AI reads project context, proposes
  plans, writes code, and runs tests.
- **Worktree isolation** — each ticket gets its own git worktree so in-progress
  work never touches the main branch until it's ready.
- **Live progress** — SSE streaming shows AI reasoning, resource usage, and test
  output as it happens. No polling, no "please wait" spinners.
- **Configurable** — all machine-specific paths, ports, and defaults live in
  `.env` or `config.json`. The code is portable across machines.

## Non-goals

- **Not a Jira replacement** — no multi-user auth, no permissions, no sprint
  planning, no burndown charts. This is a solo-developer tool.
- **Not a CI/CD system** — tests run locally via the project's own test framework.
  No pipeline orchestration, no artifact storage, no deployment.
- **Not a code review platform** — diffs are shown for awareness, not for
  threaded comments or approval gates.

## Guiding Principles

- **Token-aware** — every prompt sent to the AI is trimmed to essential context.
  The ticket-context file pattern keeps LLM KV caches warm across tool calls.
- **Fail visible** — errors stream to the UI in real time. A crashed coder call
  doesn't hide behind a generic "something went wrong".
- **No hidden state** — the SQLite database is the single source of truth.
  Migrations are explicit, and `store.json.migrated` can rebuild it from scratch.
- **Editor agnostic** — VSCode and Cursor URIs are configurable. The dashboard
  just links to your editor; it doesn't mandate one.
