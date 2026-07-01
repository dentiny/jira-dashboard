# Contributing to Jira Dashboard

Thanks for being here. This is a working v0.1 — most of the value right now is
in real-world usage on different repos, languages, and OSes. Code contributions
are welcome but **issues, repro reports, and dogfooding notes are equally valuable**.

## Quick links

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Roadmap & known limits](docs/todo.md)
- [Vision](docs/vision.md)
- [Issue tracker](https://github.com/Cutuy/jira-dashboard/issues)
- [Discussions](https://github.com/Cutuy/jira-dashboard/discussions) *(coming soon)*

## Ways to contribute

You don't have to write code to make this project better:

- **🐛 File an issue** — even "the install failed on my Mac with this error" is gold
- **🍴 Dogfood it** — install it on a real project and tell us what breaks or feels weird
- **✍️ Improve docs** — typos, unclear steps, missing screenshots. Small PRs are great
- **🔌 Write a coder backend** — `coder/claude.js` and `coder/codex.js` are stubs. If you use Claude Code or Codex, fill one in
- **🧪 Cross-platform testing** — see the matrix below
- **💸 Sponsor** — drops, infra, API credits. Not set up yet, will be.

## Reporting bugs

Open an issue with:

1. **OS + Node version** (`uname -a`, `node -v`, `npm -v`)
2. **What you ran** — exact `bootstrap.sh` invocation, env file contents (redact secrets)
3. **What you expected vs what happened** — screenshot or paste of the error
4. **Logs** — `journalctl --user -u jira-dashboard-<port>.service -n 200` (Linux) or `~/Library/Logs/jira-dashboard-<port>.log` (macOS)

For security issues, **do not** open a public issue. Email the maintainers directly (see GitHub profile).

## Development setup

```bash
git clone https://github.com/Cutuy/jira-dashboard.git
cd jira-dashboard
npm install
(cd client && npm install)
npm test                  # runs all 4 test suites
```

To run the dashboard against your own project:

```bash
JIRA_PROJECT_DIR=/path/to/your/project ./bootstrap.sh
```

## Testing matrix we want to cover

The dashboard advertises "Linux + macOS" but only `local + opencode + Linux` is
tested in CI. We need coverage of:

|              | opencode | claude code | codex | dummy |
|--------------|:--------:|:-----------:|:-----:|:-----:|
| Linux local  | ✅       |             |       |       |
| macOS local  |          |             |       |       |
| remote SSH   |          |             |       |       |
| Windows WSL  |          |             |       |       |

Pick a cell. File an issue describing what you ran. If it breaks, attach logs.

## Adding a new coder backend

The backend interface is intentionally tiny. One file, four functions:

```js
// coder/<name>.js
module.exports = function (config, store) {
  return {
    name: '<name>',
    buildArgs(prompt, sessionId, title) { /* return array of CLI args */ },
    buildEnv() { /* return env vars to add to the child process */ },
    formatProgress(line) { /* parse one stdout line, return display string or null */ },
    parseOutput(stdout) { /* parse full stdout, return { cost, input, output, sessionId } */ },
    stats() { /* optional: return cost/input/output stats for the dashboard card */ },
  };
};
```

Register it in [`coder/index.js`](coder/index.js) and pick it via
`JIRA_CODER_TYPE=<name>` in your project's `.jira-dashboard/.env`.

## Commit messages

Conventional Commits, lower-case type, present tense:

```
feat(clarify): add max-rounds config to prevent runaway clarification loops
fix(worktree): ensure changes are committed/staged after rebase
docs(readme): tighten install snippet
chore(deps): bump express to 5.2.1
```

The project follows these conventions in existing history.

## Pull requests

- One concern per PR. If you find three things to fix, open three PRs.
- Reference the issue it closes: `Closes #42`
- Tests if the change is non-trivial. `npm test` must pass.
- Update docs (`README.md`, `docs/`) if behavior changes.

## Release cadence

There is no fixed cadence. Tags happen when:

- A meaningful capability lands (new backend, new stage, new platform)
- Bug fixes that affect install or upgrade paths accumulate
- The maintainer feels like it

Versions are semantic: `0.MINOR.PATCH` until the API and config schema
stabilize. Until then, breaking changes are allowed in minor bumps.