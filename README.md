# Jira Dashboard

> **The only AI coding kanban that's self-hosted end-to-end — no companion daemon, no cloud account, no agent lock-in.**
>
> From a one-line idea to a reviewed PR — in one board.

A kanban where AI coding agents are first-class teammates. Type a rough idea,
a user complaint, a TODO scribbled in a doc — the agent asks clarifying
questions, proposes a plan, implements in an isolated git worktree, runs
tests, and hands you a branch to review. Human in the loop, no context
switching, no ticket groomers.

![Demo: ticket flow from backlog to done](docs/demo.gif)

![Architecture](docs/architecture.svg)

## Quick Start

```bash
git clone https://github.com/Cutuy/jira-dashboard.git
cd jira-dashboard
./bootstrap.sh            # interactive — prompts for project path, coder CLI, etc.
```

Opens <http://localhost:3006>. The install script:

- prompts for the project repo you want to track (any git repo)
- wires the dashboard `.env` and a systemd / launchd service for you
- builds the client and starts the server

To track multiple projects, run `./bootstrap.sh` again with a different port.

## How a ticket flows

| Stage | What happens | Desktop |
|:------|:-------------|:--------|
| **Backlog** | You add a one-line idea. The agent reads it. | ![Backlog](docs/screenshots/desktop-home.png) |
| **Clarification** | The agent asks the questions a thoughtful teammate would. You answer in the same popup. | ![Clarification](docs/screenshots/desktop-clarification.png) |
| **Implementation** | The agent writes code in an isolated worktree, commits as it goes, streams progress to the card. | ![Implementation](docs/screenshots/desktop-implementation.png) |
| **Review** | Branch diff + test output are inline. You give feedback or accept. | ![Review](docs/screenshots/desktop-review.png) |
| **Done** | Cherry-picked onto your default branch. Card closes. | ![Done](docs/screenshots/desktop-done.png) |

Mobile works too — same board, same ticket popup.

| Home | Ticket |
|:----:|:-------|
| ![Mobile home](docs/screenshots/mobile-home.png) | ![Mobile ticket](docs/screenshots/mobile-ticket.png) |

## Why this and not (X)

Honest comparison — pick what actually fits your workflow:

- **vs Linear + Claude Code manually.** Linear is great for human-only work, but every "implement this ticket" still means copy-paste between Linear and your terminal. Jira Dashboard does that handoff for you, runs locally, no account needed.
- **vs TaskMaster / claude-task-master.** Those lock you into one editor (usually Cursor) and stop at a task list. This runs the full lifecycle — clarification, implementation in a worktree, tests, branch ready to merge — and works with any AI CLI you point it at.
- **vs Devin / bolt.new / v0.** Those are cloud sandboxes with their own billing. This runs on your laptop, uses your existing API keys, owns no data. You keep the agent choice.

## Configuration

| Where | What |
|-------|------|
| `<project>/.jira-dashboard/.env` | Dashboard settings (port, project name, coder CLI path) |
| `<project>/.env` | Environment injected into the coder subprocess — **API keys go here** |
| `config.json` | Structural defaults (timeouts, venv path, test command) |

### How config loading works

1. Walks up from `cwd` looking for `.jira-dashboard/.env` → that directory becomes `projectDir`
2. Loads `.jira-dashboard/.env` as dashboard settings
3. Loads `<project>/.env` and injects into `process.env` — coder CLI inherits these
4. `config.json` values are fallbacks for everything

See [`.env.example`](.env.example) for the keys the dashboard reads.

## Coder backends

The dashboard is backend-agnostic. It speaks to whichever AI coding CLI is on your `PATH`. Out of the box:

- **opencode** — fully implemented (the default)
- **claude code**, **codex** — stubs ready, see [`coder/`](coder/) for the adapter interface
- **dummy** — for testing the pipeline without burning tokens

Adding a new backend is a single file under `coder/<name>.js` exporting `{ name, buildArgs, buildEnv, formatProgress, parseOutput }`.

## Status & honest limits

This is the dashboard we're dogfooding on this very repo — v0.3 with PR-lifecycle support (Backlog → Clarification → Implementation → Review → PR opened → Done) end to end.

- ✅ Linux + macOS service install (systemd / launchd)
- ⚠️ Resource monitor is Linux-only (`/proc/<pid>/stat`). macOS falls back to `ps`.
- Test runner is generic — set `test.command_override` in `config.json` to use any language's test command. Python (`python -m project.test`) is the default.
- ⚠️ Pre-push hook assumes `gh` CLI for pushing branches. See [`.githooks/`](.githooks/).

See [`docs/todo.md`](docs/todo.md) for the full roadmap. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Advanced usage

```bash
npm test                  # run all tests
npm run test:config       # config loader only
npm run test:prompts      # prompt templates only
git config core.hooksPath .githooks   # install pre-push hook
```

## License

[MIT](LICENSE) — © 2026 Cutuy