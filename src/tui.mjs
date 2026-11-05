import { Container, Editor, Markdown, ProcessTerminal, Text, TuiMainScreen, matchesKey } from '@earendil-works/pi-tui';
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
export function createChatUI({ color, onSubmit, onQuit, onInput, onPasteImage, hasImages = () => false, terminal = new ProcessTerminal() }) {
  const tui = new TuiMainScreen(terminal);
  const transcript = new Container();
  const live = new Container();
  const drafts = new Map();
  const draftKey = (frame) => `${frame.from}:${frame.id}`;
  const dropDraft = (key) => {
    const draft = drafts.get(key);
    if (draft) live.removeChild(draft.container);
    drafts.delete(key);
  };
  const activity = new Text('', 1, 0);
  const status = new Text('', 1, 0);
  const identity = (text) => text;
  const editor = new Editor(tui, {
    borderColor: (text) => paint(color, 'gray', text),
    selectList: Object.fromEntries(['selectedPrefix', 'selectedText', 'description', 'scrollInfo', 'noMatch'].map((key) => [key, identity])),
  });
  tui.addChild(transcript);
  tui.addChild(live);
  tui.addChild(editor);
  tui.addChild(activity);
  tui.addChild(status);
  const attachments = new Text('', 1, 0);
  tui.addChild(attachments);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    // 任何一个按键都算「人在终端前面」:调用方据此决定要不要把新消息标成已读。
    onInput?.(data);
    if (matchesKey(data, 'ctrl+v') && onPasteImage) {
      onPasteImage();
      return { consume: true };
    }
    if (data === '\u0003' || data === '\u0004' && !editor.getText()) {
      onQuit();
      return { consume: true };
    }
  });
  editor.onSubmit = (text) => {
    if (!text.trim() && !hasImages()) return;
    editor.addToHistory(text);
    editor.setText('');
    onSubmit(text.trim());
    tui.requestRender();
  };
  return {
    start: () => tui.start(),
    stop: () => tui.stop(),
    attachments(count) { attachments.setText(count ? `待发送图片 ${count}/4 · Enter 发送 · /drop 清除` : ''); tui.requestRender(); },
    out(text) { transcript.addChild(new Text(text, 1, 0)); tui.requestRender(); },
    message(message, options) {
      if (message.draft) dropDraft(draftKey({ from: message.from, id: message.draft }));
      const header = formatMessage({ ...message, text: '', images: [] }, options).trimEnd();
      transcript.addChild(new Text(`\n${header}`, 1, 0));
      transcript.addChild(message.from === 'user'
        ? new Text(String(message.text ?? ''), 2, 0)
        : new Markdown(String(message.text ?? ''), 2, 0, markdownTheme(color)));
      for (const name of message.images ?? []) transcript.addChild(new Text(`[图片] ${options.imageUrl?.(name) || name}`, 2, 0));
      tui.requestRender();
    },
    draft(frame, options) {
      if (!frame?.id || !frame.from) return;
      const key = draftKey(frame);
      if (frame.end) dropDraft(key);
      else if (typeof frame.text === 'string') {
        let draft = drafts.get(key);
        if (!draft) {
          const container = new Container();
          const header = formatMessage({ from: frame.from, ts: Date.now(), text: '' }, options).trimEnd();
          container.addChild(new Text(`\n${header} · 正在生成`, 1, 0));
          const body = new Markdown(frame.text, 2, 0, markdownTheme(color));
          container.addChild(body);
          draft = { container, body };
          drafts.set(key, draft);
          live.addChild(container);
        } else draft.body.setText(frame.text);
      }
      tui.requestRender();
    },
    clearDrafts() { drafts.clear(); live.clear(); tui.requestRender(); },
    activity(text) { activity.setText(paint(color, 'gray', text)); tui.requestRender(); },
    typing(on) { status.setText(on ? paint(color, 'gray', '… 正在输入') : ''); tui.requestRender(); },
    clear() { transcript.clear(); drafts.clear(); live.clear(); tui.requestRender(true); },
  };
}
