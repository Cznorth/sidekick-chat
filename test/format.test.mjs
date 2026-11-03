/**
 * 排版函数的测试。这些是老要改的地方(名字、模型标记、引用、超长截断),别靠肉眼看终端。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayLabel, formatConversation, formatMessage, oneLine, senderName } from '../src/format.mjs';
import { parseFrame } from '../src/api.mjs';
import { pickConv } from '../src/main.mjs';

const bots = [
  { id: 'sidekick', name: '秘书', primary: true },
  { id: 'intake', name: '收发室' },
];
const ts = new Date(2026, 10, 3, 13, 39, 5).getTime();

test('发送者名字:我自己、系统、名册里的名字、查不到的 id', () => {
  assert.equal(senderName({ from: 'user' }, bots), '我');
  assert.equal(senderName({ from: 'system' }, bots), '系统');
  assert.equal(senderName({ from: 'sidekick' }, bots), '秘书');
  assert.equal(senderName({ from: 'ghost' }, bots), 'ghost');
});

test('一条消息:头行带时间和模型,正文缩进两格', () => {
  const text = formatMessage({ from: 'sidekick', ts, text: '好的\n第二行', model: 'codex/gpt-5.5' }, { bots });
  assert.deepEqual(text.split('\n'), ['[13:39] 秘书 codex/gpt-5.5', '  好的', '  第二行']);
});

test('引用和图片:都排出来,不带颜色时是纯文本', () => {
  const text = formatMessage(
    {
      from: 'sidekick',
      ts,
      text: '看这个',
      reply_to: { seq: 3, from: 'user', name: '我', text: '帮我看看' },
      images: ['a.jpg'],
    },
    { bots, imageUrl: (name) => `https://x/img/${name}` },
  );
  assert.match(text, /↳ 回复 我:帮我看看/);
  assert.match(text, /\[图片\] https:\/\/x\/img\/a\.jpg/);
  assert.ok(!text.includes('\u001b['));
});

test('上色模式带 ANSI,NO_COLOR 之外的开关由调用方决定', () => {
  const text = formatMessage({ from: 'user', ts, text: 'hi' }, { bots, color: true });
  assert.match(text, /\u001b\[/);
});

test('会话列表:当前会话打 *,未读数写出来', () => {
  const conv = { id: 'dm:sidekick', title: '秘书', unread: 3, last: { from: 'sidekick', text: '晚安' } };
  const line = formatConversation(conv, 2, { bots, current: 'dm:sidekick' });
  assert.match(line, /^\* 2\. 秘书 \(3\)/);
  assert.match(line, /秘书:晚安/);
});

test('oneLine 把换行压平并截断', () => {
  assert.equal(oneLine('a\n\nb   c', 10), 'a b c');
  assert.equal(oneLine('一二三四五六', 3), '一二三…');
});

test('dayLabel 用本地日期', () => {
  assert.equal(dayLabel(ts), '2026-11-03');
});

test('parseFrame 认 event 和 data,注释行返回 null', () => {
  assert.deepEqual(parseFrame('event: message\ndata: {"seq":1}'), { event: 'message', data: { seq: 1 } });
  assert.equal(parseFrame('retry: 3000'), null);
  assert.equal(parseFrame('data: not-json'), null);
});

test('pickConv 认序号、id、名字,挑不到退回私聊', () => {
  const state = {
    primary: 'sidekick',
    bots,
    latest: 0,
    conversations: [
      { id: 'dm:sidekick', title: '秘书' },
      { id: 'g:12345678', title: '项目群' },
    ],
  };
  assert.equal(pickConv(state, ''), 'dm:sidekick');
  assert.equal(pickConv(state, '2'), 'g:12345678');
  assert.equal(pickConv(state, '项目群'), 'g:12345678');
  assert.equal(pickConv(state, 'dm:sidekick'), 'dm:sidekick');
  assert.equal(pickConv(state, 'nope'), 'dm:sidekick');
});
