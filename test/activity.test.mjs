import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyActivity, formatActivity } from '../src/activity.mjs';

test('activity formatting handles missing records and preserves call time and activity', () => {
  assert.equal(formatActivity({}), '尚无 LLM 活动记录');
  const at = new Date(2026, 10, 4, 14, 28, 3).getTime();
  assert.equal(formatActivity({ lastActiveAt: at, lastActivity: '事项提醒\n第 2 轮' }), '最后活跃 2026-11-04 14:28:03 · 事项提醒 第 2 轮');
});

test('activity SSE updates only its bot and rejects stale or invalid frames', () => {
  const bots = [{ id: 'a' }, { id: 'b' }];
  assert.equal(applyActivity(bots, { bot: 'a', at: 2000, text: '回你的消息' }), true);
  assert.equal(applyActivity(bots, { bot: 'a', at: 1000, text: '旧记录' }), false);
  assert.equal(applyActivity(bots, { bot: 'missing', at: 3000 }), false);
  assert.equal(applyActivity(bots, { bot: 'a', at: NaN }), false);
  assert.equal(formatActivity(bots[1]), '尚无 LLM 活动记录');
  assert.equal(bots[0].lastActivity, '回你的消息');
});
