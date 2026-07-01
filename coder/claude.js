const path = require('path');

module.exports = function claudeBackend(config, store) {
  return {
    name: 'claude',

    stats() { return store.lastUsage; },

    buildArgs(prompt, sessionId, title) {
      const args = ['-p', '--verbose', '--output-format', 'stream-json'];
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
        if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta' && evt.event.delta?.type === 'text_delta') {
          return evt.event.delta.text;
        }
      } catch {}
      return null;
    },

    parseOutput(stdout) {
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return stdout;
        const lines = trimmed.split('\n');

        if (lines.length === 1) {
          const data = JSON.parse(trimmed);
          if (data.result !== undefined) {
            store.setUsage({
              cost: data.total_cost_usd || 0,
              input: String(data.usage?.input_tokens || 0),
              output: String(data.usage?.output_tokens || 0),
            });
            if (data.session_id) store.setSessionId(data.session_id);
            return String(data.result);
          }
          return stdout;
        }

        let text = '';
        let sessionId = null;
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
              sessionId = evt.session_id;
            }
            if (evt.type === 'assistant' && evt.message?.usage) {
              const content = evt.message.content || [];
              text = content.map(c => c.text || '').join('');
            }
            if (evt.type === 'result' && evt.subtype === 'success') {
              if (evt.total_cost_usd !== undefined) {
                store.setUsage({
                  cost: evt.total_cost_usd,
                  input: String(evt.usage?.input_tokens || 0),
                  output: String(evt.usage?.output_tokens || 0),
                });
              }
              if (evt.session_id) store.setSessionId(evt.session_id);
              else if (sessionId) store.setSessionId(sessionId);
              if (evt.result !== undefined) text = String(evt.result);
            }
          } catch {}
        }
        if (text) return text;
      } catch {}
      return stdout;
    },
  };
};
