const path = require('path');

module.exports = function claudeBackend(config, store) {
  // Per-message token tracking for cumulative live display.
  // Claude reports usage per-message (not cumulative), so we
  // track deltas between consecutive message_delta events.
  let _lastIn = 0, _lastOut = 0;

  return {
    name: 'claude',

    stats() { return store.lastUsage; },

    buildArgs(prompt, sessionId, title) {
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
          if (ee?.type === 'message_start') { _lastIn = 0; _lastOut = 0; }
          if (ee?.type === 'message_delta' && ee.usage) {
            const msgIn = ee.usage.input_tokens || 0;
            const msgOut = ee.usage.output_tokens || 0;
            const deltaIn = Math.max(0, msgIn - _lastIn);
            const deltaOut = Math.max(0, msgOut - _lastOut);
            _lastIn = msgIn; _lastOut = msgOut;
            const prev = store.lastUsage;
            store.setUsage({
              cost: prev.cost || 0,
              input: String((parseInt(prev.input) || 0) + deltaIn),
              output: String((parseInt(prev.output) || 0) + deltaOut),
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
                const prev = store.lastUsage;
                const prevCost = prev.cost || 0;
                tokens = {
                  cost: evt.total_cost_usd,
                  input: String(evt.usage?.input_tokens || 0),
                  output: String(evt.usage?.output_tokens || 0),
                };
                store.setUsage({
                  cost: prevCost + (evt.total_cost_usd || 0),
                  input: prev.input,
                  output: prev.output,
                });
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
