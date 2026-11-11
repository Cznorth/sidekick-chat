import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, Text, TuiMainScreen, matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { paint, formatMessage, attachmentLines } from './format.mjs';
import { formatTasks } from './watch.mjs';

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
export function createChatUI({ color, onSubmit, onQuit, onInput, onPasteImage, onOpenCard, onTaskSelect, onTaskClose, hasImages = () => false, terminal = new ProcessTerminal() }) {
  const tui = new TuiMainScreen(terminal);
  const transcript = new Container();
  const live = new Container();
  const drafts = new Map();
  const cardButtons = new Map();
  let mouseDown = null;
  let pendingClick = null;
  let clickTimer = null;
  function openClickedCard(x, y, cursorRow) {
    // DSR gives the real cursor row even when the shell started the TUI mid-screen.
    // TuiMainScreen's hardwareCursorRow is in document coordinates.
    const line = tui.hardwareCursorRow + y - cursorRow;
    let top = 0;
    for (const component of transcript.children) {
      const lines = component.render(terminal.columns);
      const uri = cardButtons.get(component);
      if (uri && line >= top && line < top + lines.length) {
        const rendered = lines[line - top].replace(/\x1b\[[0-9;]*m/g, '');
        const leading = rendered.length - rendered.trimStart().length;
        if (x >= leading && x < visibleWidth(rendered.trimEnd())) onOpenCard?.(uri);
        return;
      }
      top += lines.length;
    }
  }
  const draftKey = (frame) => `${frame.from}:${frame.id}`;
  const dropDraft = (key) => {
    const draft = drafts.get(key);
    if (draft) live.removeChild(draft.container);
    drafts.delete(key);
  };
  const watch = new Text('', 1, 0);
  const taskHud = new Text('', 1, 0);
  let tasks = [];
  let taskError = '';
  let selecting = false;
  let selected = 0;
  let viewingTask = false;
  const renderTasks = () => { taskHud.setText(formatTasks(tasks, { selected, selecting, error: taskError })); tui.requestRender(); };
  const activity = new Text('', 1, 0);
  const status = new Text('', 1, 0);
  const identity = (text) => text;
  const editor = new Editor(tui, {
    borderColor: (text) => paint(color, 'gray', text),
    selectList: Object.fromEntries(['selectedPrefix', 'selectedText', 'description', 'scrollInfo', 'noMatch'].map((key) => [key, identity])),
  });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    ['help', '显示命令'], ['conv', '列出会话'], ['to', '切换会话'], ['history', '查看历史'],
    ['who', '查看成员'], ['context', '查看上下文'], ['usage', '查看额度'], ['watch', '观察任务'],
    ['open', '打开附件'], ['paste', '粘贴图片'], ['image', '添加图片'], ['send', '发送消息'],
    ['drop', '清除图片'], ['clear', '清屏'], ['quit', '退出'],
    ['convs', '列出会话'], ['ls', '列出会话'], ['switch', '切换会话'], ['h', '查看历史'],
    ['quota', '查看额度'], ['exit', '退出'], ['q', '退出'], ['?', '显示命令'],
  ].map(([name, description]) => ({ name, description })), process.cwd()));
  tui.addChild(transcript);
  tui.addChild(live);
  tui.addChild(watch);
  tui.addChild(editor);
  tui.addChild(taskHud);
  tui.addChild(activity);
  tui.addChild(status);
  const attachments = new Text('', 1, 0);
  tui.addChild(attachments);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    const cursor = /^\x1b\[(\d+);\d+R$/.exec(data);
    if (cursor && pendingClick) {
      const click = pendingClick;
      pendingClick = null;
      clearTimeout(clickTimer);
      openClickedCard(click.x, click.y, Number(cursor[1]) - 1);
      return { consume: true };
    }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse) {
      const button = Number(mouse[1]);
      const point = { x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 };
      if (mouse[4] === 'M' && button === 0) mouseDown = point;
      else if (mouse[4] === 'm') {
        if (button === 0 && mouseDown?.x === point.x && mouseDown?.y === point.y) {
          pendingClick = point;
          clearTimeout(clickTimer);
          clickTimer = setTimeout(() => { pendingClick = null; }, 1000);
          terminal.write('\x1b[6n');
        }
        mouseDown = null;
      }
      return { consume: true };
    }
    // 任何一个按键都算「人在终端前面」:调用方据此决定要不要把新消息标成已读。
    onInput?.(data);
    if (matchesKey(data, 'ctrl+t')) {
      selecting = !selecting;
      if (selecting) selected = 0;
      renderTasks();
      return { consume: true };
    }
    // Claude Code-style task navigation: when the editor is empty, the arrow
    // keys move focus straight into the always-visible task list. This keeps
    // the HUD keyboard-first without requiring a shortcut first.
    if (!selecting && !editor.getText()) {
      if (matchesKey(data, 'down') && tasks.length) {
        selecting = true;
        selected = 1;
        renderTasks();
        return { consume: true };
      }
      if (matchesKey(data, 'up') && tasks.length) {
        selecting = true;
        selected = tasks.length;
        renderTasks();
        return { consume: true };
      }
    }
    if (selecting) {
      if (matchesKey(data, 'escape')) { selecting = false; renderTasks(); return { consume: true }; }
      if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        selected = Math.max(0, Math.min(tasks.length, selected + (matchesKey(data, 'up') ? -1 : 1)));
        renderTasks();
        return { consume: true };
      }
      if (matchesKey(data, 'enter')) {
        selecting = false;
        viewingTask = selected > 0;
        if (viewingTask) onTaskSelect?.(tasks[selected - 1].id);
        else onTaskClose?.();
        renderTasks();
        return { consume: true };
      }
      if (data === '\u0003') { onQuit(); return { consume: true }; }
      return { consume: true };
    }
    if (viewingTask && matchesKey(data, 'escape')) {
      viewingTask = false;
      onTaskClose?.();
      return { consume: true };
    }
    if ((matchesKey(data, 'ctrl+v') || matchesKey(data, 'ctrl+g')) && onPasteImage) {
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
    start() { tui.start(); terminal.write('\x1b[?1000h\x1b[?1006h'); },
    stop() { clearTimeout(clickTimer); terminal.write('\x1b[?1000l\x1b[?1006l'); tui.stop(); },
    attachments(count) { attachments.setText(count ? `待发送图片 ${count}/4 · Enter 发送 · /drop 清除` : ''); tui.requestRender(); },
    out(text) { transcript.addChild(new Text(text, 1, 0)); tui.requestRender(); },
    message(message, options) {
      if (message.draft) dropDraft(draftKey({ from: message.from, id: message.draft }));
      const header = formatMessage({ ...message, text: '', images: [], files: [] }, options).trimEnd();
      transcript.addChild(new Text(`\n${header}`, 1, 0));
      const links = [];
      const body = String(message.text ?? '').replace(/\[([^\]\r\n]{1,80})\]\((sidekick:\/\/(?:task|board)\/\d+)\)/g, (_, label, uri) => {
        links.push({ label, uri });
        return '';
      });
      transcript.addChild(message.from === 'user'
        ? new Text(body, 2, 0)
        : new Markdown(body, 2, 0, markdownTheme(color)));
      for (const { label, uri } of links) {
        const button = new Text(paint(color, 'cyan', `[${label} · ${uri.split('/').at(-1)}]`), 2, 0);
        cardButtons.set(button, uri);
        transcript.addChild(button);
      }
      for (const line of attachmentLines(message, options)) transcript.addChild(new Text(line, 2, 0));
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
    watch(text) { watch.setText(text); tui.requestRender(); },
    tasks(next, error = '') {
      const selectedId = selected > 0 ? tasks[selected - 1]?.id : null;
      tasks = next;
      taskError = error;
      selected = selectedId == null ? 0 : Math.max(0, tasks.findIndex((task) => task.id === selectedId) + 1);
      renderTasks();
    },
    activity(text) { activity.setText(paint(color, 'gray', text)); tui.requestRender(); },
    typing(on) { status.setText(on ? paint(color, 'gray', '… 正在输入') : ''); tui.requestRender(); },
    clear() { transcript.clear(); cardButtons.clear(); drafts.clear(); live.clear(); tui.requestRender(true); },
  };
}
