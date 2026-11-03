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
