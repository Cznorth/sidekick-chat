import { Container, Editor, Markdown, ProcessTerminal, Text, TuiMainScreen } from '@earendil-works/pi-tui';
import { paint, formatMessage } from './format.mjs';

export function markdownTheme(color) {
  const style = (code) => (text) => paint(color, code, text);
  return Object.fromEntries(Object.entries({
    heading: 'bold', link: 'cyan', linkUrl: 'gray', code: 'yellow',
    codeBlock: 'yellow', codeBlockBorder: 'gray', quote: 'gray', quoteBorder: 'gray',
    hr: 'gray', listBullet: 'cyan', bold: 'bold', italic: 'dim',
    strikethrough: 'dim', underline: 'cyan',
  }).map(([name, code]) => [name, style(code)]));
}

/** Pi's renderer owns every screen write, including the editor and busy status. */
export function createChatUI({ color, onSubmit, onQuit, terminal = new ProcessTerminal() }) {
  const tui = new TuiMainScreen(terminal);
  const transcript = new Container();
  const status = new Text('', 1, 0);
  const identity = (text) => text;
  const editor = new Editor(tui, {
    borderColor: (text) => paint(color, 'gray', text),
    selectList: Object.fromEntries(['selectedPrefix', 'selectedText', 'description', 'scrollInfo', 'noMatch'].map((key) => [key, identity])),
  });
  tui.addChild(transcript);
  tui.addChild(status);
  tui.addChild(editor);
  tui.addChild(new Text(paint(color, 'gray', 'Enter 发送 · Shift+Enter 换行 · ↑ 历史 · /help · Ctrl+C 退出'), 1, 0));
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (data === '\u0003' || data === '\u0004' && !editor.getText()) {
      onQuit();
      return { consume: true };
    }
  });
  editor.onSubmit = (text) => {
    if (!text.trim()) return;
    editor.addToHistory(text);
    editor.setText('');
    onSubmit(text.trim());
    tui.requestRender();
  };
  return {
    start: () => tui.start(),
    stop: () => tui.stop(),
    out(text) { transcript.addChild(new Text(text, 1, 0)); tui.requestRender(); },
    message(message, options) {
      const header = formatMessage({ ...message, text: '', images: [] }, options).trimEnd();
      transcript.addChild(new Text(`\n${header}`, 1, 0));
      transcript.addChild(message.from === 'user'
        ? new Text(String(message.text ?? ''), 2, 0)
        : new Markdown(String(message.text ?? ''), 2, 0, markdownTheme(color)));
      for (const name of message.images ?? []) transcript.addChild(new Text(`[图片] ${options.imageUrl?.(name) || name}`, 2, 0));
      tui.requestRender();
    },
    typing(on) { status.setText(on ? paint(color, 'gray', '… 正在输入') : ''); tui.requestRender(); },
    clear() { transcript.clear(); tui.requestRender(true); },
  };
}
