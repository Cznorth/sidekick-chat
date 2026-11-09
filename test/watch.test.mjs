import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWatch } from '../src/watch.mjs';
test('watch view bounds output and strips terminal controls', () => {
  const session = { status: 'running', messages: [{ role: 'assistant', parts: [{ type: 'tool', tool: 'run_command', title: 'npm test', status: 'in_progress', output: 'one\ntwo\n\x1b[31mthree' }] }] };
  const compact = formatWatch({ id: 42, instance: 'Codex', session });
  assert.match(compact, /T-42.*Codex.*running/); assert.match(compact, /run_command.*npm test/);
  assert.match(compact, /three/); assert.doesNotMatch(compact, /one/); assert.doesNotMatch(compact, /\x1b/);
  assert.match(formatWatch({ id: 42, instance: 'Codex', session }, true), /one/);
});
