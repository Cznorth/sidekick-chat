import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/headless';
import { createChatUI } from '../src/tui.mjs';

class Terminal {
  columns = 48;
  rows = 24;
  kittyProtocolActive = false;
  screen = new xterm.Terminal({ cols: 48, rows: 24, allowProposedApi: true });
  pending = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  write(data) { this.pending.push(new Promise((resolve) => this.screen.write(data, resolve))); }
  hideCursor() {}
  showCursor() {}
  moveBy() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  async flush() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all(this.pending.splice(0));
  }
  text() {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n');
  }
}

test('image paste shortcut preserves text and allows image-only submission', async () => {
  const terminal = new Terminal();
  const sent = [];
  let count = 0;
  const ui = createChatUI({ color: false, terminal, onSubmit: (text) => sent.push(text), onQuit() {},
    hasImages: () => count > 0, onPasteImage: () => { count++; ui.attachments(count); } });
  ui.start();
  try {
    terminal.input('看看');
    terminal.input('\u0016');
    await terminal.flush();
    assert.match(terminal.text(), /待发送图片 1\/4/);
    terminal.input('\r');
    assert.deepEqual(sent, ['看看']);
    terminal.input('\r');
    assert.deepEqual(sent, ['看看', '']);
  } finally {
    ui.stop();
    await terminal.flush();
    terminal.screen.dispose();
  }
});

test('stream snapshots update in place, finalize once, and preserve the input cursor', async () => {
  const terminal = new Terminal();
  const sent = [];
  const ui = createChatUI({ color: false, terminal, onSubmit: (text) => sent.push(text), onQuit() {} });
  const options = { bots: [{ id: 'bot', name: '秘书' }], color: false };
  ui.start();
  try {
    terminal.input('草稿');
    terminal.input('\u001b[D');
    ui.draft({ id: 'a', from: 'bot', text: '**流式**第一段' }, options);
    await terminal.flush();
    assert.match(terminal.text(), /流式第一段/);
    ui.draft({ id: 'a', from: 'bot', text: '**流式**第一段第二段' }, options);
    await terminal.flush();
    assert.equal(terminal.text().split('流式第一段第二段').length - 1, 1);
    ui.message({ seq: 1, from: 'bot', ts: 0, draft: 'a', text: '最终正文' }, options);
    await terminal.flush();
    assert.ok(!terminal.text().includes('流式第一段'));
    assert.ok(!terminal.text().includes('正在生成'));
    assert.equal(terminal.text().split('最终正文').length - 1, 1);
    terminal.input('X');
    terminal.input('\r');
    assert.deepEqual(sent, ['草X稿']);
  } finally {
    ui.stop();
    await terminal.flush();
    terminal.screen.dispose();
  }
});

test('draft cancellation and disconnect cleanup do not remove other senders or final messages', async () => {
  const terminal = new Terminal();
  const ui = createChatUI({ color: false, terminal, onSubmit() {}, onQuit() {} });
  ui.start();
  try {
    ui.message({ from: 'bot', ts: 0, text: '已发送正文' }, {});
    ui.draft({ id: 'same', from: 'a', text: '撤回的草稿' }, {});
    ui.draft({ id: 'same', from: 'b', text: '另一成员草稿' }, {});
    ui.draft({ id: 'same', from: 'a', end: true }, {});
    await terminal.flush();
    assert.ok(!terminal.text().includes('撤回的草稿'));
    assert.match(terminal.text(), /另一成员草稿/);
    ui.clearDrafts();
    await terminal.flush();
    assert.ok(!terminal.text().includes('另一成员草稿'));
    assert.match(terminal.text(), /已发送正文/);
  } finally {
    ui.stop();
    await terminal.flush();
    terminal.screen.dispose();
  }
});

test('Pi renderer preserves a wrapped Chinese draft and cursor while a Markdown reply arrives and terminal resizes', async () => {
  const terminal = new Terminal();
  const sent = [];
  let quit = false;
  const ui = createChatUI({ color: false, terminal, onSubmit: (text) => sent.push(text), onQuit: () => { quit = true; } });
  ui.start();
  try {
    const draft = '这是一条还没发送的中文草稿'.repeat(4);
    terminal.input(draft);
    terminal.input('\u001b[D'); // Keep cursor before the last character.
    ui.typing(true);
    await terminal.flush();
    ui.message({ from: 'bot', ts: 0, text: '## 结果\n\n**完成**\n\n```js\nconsole.log(1)\n```' }, { color: false });
    ui.typing(false);
    terminal.columns = 32;
    terminal.screen.resize(32, 24);
    terminal.resize();
    await terminal.flush();
    const text = terminal.text();
    assert.match(text, /结果/);
    assert.match(text, /console.log\(1\)/);
    assert.ok(!text.includes('**完成**'));
    assert.ok(!text.includes('正在输入'));
    terminal.input('X');
    terminal.input('\r');
    assert.deepEqual(sent, [draft.slice(0, -1) + 'X' + draft.slice(-1)]);
    terminal.input('\u0003');
    assert.equal(quit, true);
  } finally {
    ui.stop();
    await terminal.flush();
    terminal.screen.dispose();
  }
});

test('bracketed multiline paste submits as one message and clear preserves the draft', async () => {
  const terminal = new Terminal();
  const sent = [];
  const ui = createChatUI({ color: true, terminal, onSubmit: (text) => sent.push(text), onQuit() {} });
  ui.start();
  try {
    terminal.input('\u001b[200~第一行\n第二行\u001b[201~');
    ui.out('待清除消息');
    ui.clear();
    await terminal.flush();
    terminal.input('\r');
    assert.deepEqual(sent, ['第一行\n第二行']);
    assert.ok(!terminal.text().includes('待清除消息'));
  } finally {
    ui.stop();
    await terminal.flush();
    terminal.screen.dispose();
  }
});


test('activity remains visible through busy changes and preserves typed text', async () => {
  const terminal = new Terminal();
  const sent = [];
  const ui = createChatUI({ color: false, terminal, onSubmit: t => sent.push(t), onQuit() {} });
  ui.start();
  try {
    terminal.input('还没发');
    ui.activity('秘书: 最后活跃 14:28 · 事项提醒\n上下文 ≈ 68,000 / 200,000 token · 34%');
    ui.typing(true);
    await terminal.flush();
    assert.match(terminal.text(), /事项提醒/);
    assert.match(terminal.text(), /68,000 \/ 200,000/);
    ui.typing(false);
    ui.activity('秘书: 最后活跃 14:29 · 回你的消息\n上下文 ≈ 1,000 / 200,000 token · 1%');
    await terminal.flush();
    assert.match(terminal.text(), /回你的消息/);
    assert.match(terminal.text(), /1,000 \/ 200,000/);
    assert.ok(!terminal.text().includes('事项提醒'));
    terminal.input('完'); terminal.input('\r');
    assert.deepEqual(sent, ['还没发完']);
  } finally {
    ui.stop(); await terminal.flush(); terminal.screen.dispose();
  }
});
