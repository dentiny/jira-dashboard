const path = require('path');

module.exports = function claudeBackend(config, store) {
  return {
    name: 'claude',

    stats() { return store.lastUsage; },

    buildArgs(prompt, sessionId, title) {
      // NOTE: Claude Code uses `--output-format` (not `--format`). The latter
      // is an OpenCode flag and will be rejected by `claude` with
      //   error: unknown option '--format'
      // `--output-format stream-json` also requires `--verbose` to be passed
      // before it, or `claude` errors with
      //   "When using --print, --output-format=stream-json requires --verbose"
      // `--include-partial-messages` streams text_delta events so the live
      // view shows the coder's output as it's produced (see formatProgress).
      // `--dangerously-skip-permissions` is REQUIRED for the implement stage:
      // in headless `-p` mode there is no interactive prompt, so any Edit /
      // Write / Bash tool call that needs approval is auto-denied. Without this
      // flag the coder produces a text-only "I couldn't get permission" result,
      // makes zero file changes, and the commit is silently skipped
      // ("no uncommitted changes in worktree").
      // Resume a previous session with `-r <sessionId>`.
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions'];
      if (sessionId) args.push('-r', sessionId);
      args.push(prompt);
      return args;
    },

    buildEnv() {
      return {
        HOME: process.env.HOME,
        PATH: `${config.venvBin()}:${process.env.PATH}`,
        VIRTUAL_ENV: path.join(config.projectDir, config.venv.dir),
      };
    },

    formatProgress(line) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'stream_event') {
          const ee = evt.event;
          // Real-time token data from message_start / message_delta
          if ((ee?.type === 'message_start' && ee.message?.usage) || (ee?.type === 'message_delta' && ee.usage)) {
            const usage = ee.type === 'message_start' ? ee.message.usage : ee.usage;
            store.setUsage({
              cost: 0,
              input: String(usage.input_tokens || 0),
              output: String(usage.output_tokens || 0),
            });
          }
          if (ee?.type === 'content_block_delta' && ee.delta?.type === 'text_delta') {
            return ee.delta.text;
          }
        }
      } catch {}
      return null;
    },

    parseOutput(stdout) {
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return { text: stdout, tokens: null, sessionId: null };
        const lines = trimmed.split('\n');

        if (lines.length === 1) {
          const data = JSON.parse(trimmed);
          if (data.result !== undefined) {
            const tokens = {
              cost: data.total_cost_usd || 0,
              input: String(data.usage?.input_tokens || 0),
              output: String(data.usage?.output_tokens || 0),
            };
            const sessionId = data.session_id || null;
            store.setUsage(tokens);
            if (sessionId) store.setSessionId(sessionId);
            return { text: String(data.result), tokens, sessionId };
          }
          return { text: stdout, tokens: null, sessionId: null };
        }

        let text = '';
        let tokens = null;
        let sessionId = null;
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
              sessionId = evt.session_id;
            }
            if (evt.type === 'assistant' && evt.message?.usage) {
              const content = evt.message.content || [];
              text += content.map(c => c.text || '').join('');
            }
            if (evt.type === 'result' && evt.subtype === 'success') {
              if (evt.total_cost_usd !== undefined) {
                tokens = {
                  cost: evt.total_cost_usd,
                  input: String(evt.usage?.input_tokens || 0),
                  output: String(evt.usage?.output_tokens || 0),
                };
                store.setUsage(tokens);
              }
              if (evt.session_id) { sessionId = evt.session_id; store.setSessionId(evt.session_id); }
              else if (sessionId) store.setSessionId(sessionId);
              if (evt.result !== undefined) text = String(evt.result);
            }
          } catch {}
        }
        if (text) return { text, tokens, sessionId };
      } catch {}
      return { text: stdout, tokens: null, sessionId: null };
    },
  };
};
