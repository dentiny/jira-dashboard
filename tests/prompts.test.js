// tests/prompts.test.js — Prompt template unit tests

let assert;
try { assert = require('assert'); } catch { assert = require('node:assert'); }

function reloadPrompts() {
  delete require.cache[require.resolve('../prompts')];
  // Prompts depend on config, so clear that too
  delete require.cache[require.resolve('../config')];
  return require('../prompts');
}

// ── All stage prompts are present and non-trivial ──────────
(function testAllStagesPresent() {
  const p = reloadPrompts();
  const stages = ['clarify', 'evaluate', 'implement', 'resolveConflict', 'suggest', 'prTasks'];
  for (const s of stages) {
    assert.ok(typeof p[s] === 'string', `${s} prompt should be a string`);
    assert.ok(p[s].length > 50, `${s} prompt should be substantial`);
  }
  console.log('PASS: all stage prompts present and non-trivial');
})();

// ── prTasks prompt references input JSON (not free-text) ──
(function testPrTasksReferencesInputJson() {
  const p = reloadPrompts();
  const prompt = p.prTasks;
  assert.ok(prompt.includes('input JSON'), 'prTasks prompt should reference the input JSON file');
  assert.ok(prompt.includes('skip ignored_checks'), 'prTasks prompt should limit scope to listed checks');
  assert.ok(prompt.includes('rework_checks'), 'prTasks prompt should mention rework_checks output');
  assert.ok(prompt.includes('touched_checks') || prompt.includes('rework_checks'), 'prTasks prompt should reference output schema fields');
  console.log('PASS: prTasks prompt references input JSON and output fields');
})();

// ── Prompts include project name (not "undefined") ─────────
(function testProjectNameInPrompts() {
  delete require.cache[require.resolve('../config')];
  const p = reloadPrompts();
  // clarify, implement, suggest should all mention the project name
  for (const key of ['clarify', 'implement', 'suggest']) {
    assert.ok(!p[key].includes('undefined'), `${key} prompt should not contain "undefined"`);
  }
  console.log('PASS: prompts do not contain "undefined"');
})();

// ── Prompts are valid template strings ─────────────────────
(function testNoTemplatePlaceholders() {
  const p = reloadPrompts();
  for (const [key, text] of Object.entries(p)) {
    assert.ok(!text.includes('${'), `${key} prompt should not have unresolved template placeholders`);
  }
  console.log('PASS: no unresolved template placeholders');
})();

console.log('\n✅ All prompts tests passed\n');
