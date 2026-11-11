import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTasks, formatWatch } from '../src/watch.mjs';

test('task HUD bounds and sanitizes display, retains selected task and shows durations', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, title: `任务\u001b[31m${index}`, status: 'running', startedAt: '2026-01-01T00:00:00Z' }));
  const text = formatTasks(tasks, { selected: 7, selecting: true, now: Date.parse('2026-01-01T00:01:05Z') });
  assert.match(text, /› T-7/);
  assert.match(text, /1分5秒/);
  assert.doesNotMatch(text, /\u001b/);
  assert.doesNotMatch(text, /T-1 /);
  assert.match(formatTasks([], { error: '离线' }), /任务列表不可用/);
});
test('watch view bounds output and strips terminal controls', () => {
  const session = { status: 'running', messages: [{ role: 'assistant', parts: [{ type: 'tool', tool: 'run_command', title: 'npm test', status: 'in_progress', output: 'one\ntwo\n\x1b[31mthree' }] }] };
  const compact = formatWatch({ id: 42, instance: 'Codex', session });
  assert.match(compact, /T-42.*Codex.*running/); assert.match(compact, /run_command.*npm test/);
  assert.match(compact, /three/); assert.doesNotMatch(compact, /one/); assert.doesNotMatch(compact, /\x1b/);
  assert.match(formatWatch({ id: 42, instance: 'Codex', session }, true), /one/);
});
