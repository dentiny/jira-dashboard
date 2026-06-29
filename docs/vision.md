# Jira Dashboard — Vision

A kanban board for wishlist-driven development with AI agents.

Start with ambiguity — a rough idea, a user complaint, a TODO scribbled in a doc.
The agent asks clarifying questions, proposes a plan, implements in an isolated
worktree, and runs tests. You review, give feedback, and close. Human and agent
in the loop, no context switches, no ticket groomers.

## Goals

- Zero-config setup for a new project: one install script, one `.env` edit
- Works with any AI coding CLI (opencode, claude code, codex, etc.)
- Runs on any OS (Linux systemd, macOS launchd, Windows schtasks)
- Fail-loud, token-aware, editor-agnostic

## Guiding Principles

- Token-aware, fail-visible, no hidden state
- Editor-agnostic, user owns their data, no telemetry
