import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyContext, formatContext } from '../src/context.mjs';

test('context shows estimated tokens, configured budget and percent without inventing missing usage', () => {
  assert.equal(formatContext({}), '上下文用量未知');
  assert.equal(formatContext({ context: { estTokens: null, maxTokens: 200000 } }), '上下文用量未知');
  assert.equal(formatContext({ context: { estTokens: 68000, maxTokens: 200000 } }), '上下文 ≈ 68,000 / 200,000 token · 34%');
  assert.match(formatContext({ context: { estTokens: 0, maxTokens: 200000 } }), /0 \/ 200,000 token · 0%/);
  assert.match(formatContext({ context: { estTokens: 220000, maxTokens: 200000 } }), /110%/);
});

test('context frames isolate bots, reject stale/invalid data and allow usage to drop on handoff', () => {
  const bots = [{ id: 'a' }, { id: 'b' }];
  assert.equal(applyContext(bots, { bot: 'a', at: 2000, estTokens: 68000, maxTokens: 200000 }), true);
  for (const frame of [
    { bot: 'a', at: 1000, estTokens: 1, maxTokens: 1000 },
    { bot: 'a', at: 3000, estTokens: -1, maxTokens: 1000 },
    { bot: 'a', at: 3000, estTokens: 1, maxTokens: 0 },
    { bot: 'missing', at: 3000, estTokens: 1, maxTokens: 1000 },
  ]) assert.equal(applyContext(bots, frame), false);
  assert.equal(applyContext(bots, { bot: 'a', at: 3000, estTokens: 1000, maxTokens: 300000 }), true);
  assert.match(formatContext(bots[0]), /1,000 \/ 300,000/);
  assert.equal(formatContext(bots[1]), '上下文用量未知');
});
