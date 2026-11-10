/** Compact, bounded live view; all strings are rendered as text, never terminal controls. */
const clean = (s) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const trim = (s, n) => { const v = clean(s); return v.length > n ? `…${v.slice(-n)}` : v; };

export function formatTasks(tasks, { selected = 0, selecting = false, error = '', now = Date.now() } = {}) {
  const lines = [`${selecting && selected === 0 ? '›' : ' '} main · 当前对话${selecting ? '' : ' · Ctrl+T 选择任务'}`];
  if (error) lines.push(`  任务列表不可用: ${trim(error.replace(/\s+/g, ' '), 60)}`);
  if (!tasks.length && !error) lines.push('  暂无进行中的任务');
  const first = selecting ? Math.max(0, Math.min(selected - 3, tasks.length - 4)) : 0;
  for (const [index, task] of tasks.slice(first, first + 4).entries()) {
    const started = Date.parse(task.startedAt || task.createdAt);
    const finished = Date.parse(task.finishedAt || '');
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor(((Number.isFinite(finished) ? finished : now) - started) / 1000)) : null;
    const duration = seconds === null ? '' : seconds < 60 ? ` · ${seconds}秒` : ` · ${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    lines.push(`${selecting && selected === first + index + 1 ? '›' : ' '} T-${task.id} · ${trim(String(task.title || '').replace(/\s+/g, ' '), 36)} · ${clean(task.status).replace(/\s+/g, ' ')}${duration}`);
  }
  if (tasks.length > 4) lines.push(`  共 ${tasks.length} 项${selecting ? '' : '，Ctrl+T 查看全部'}`);
  if (selecting) lines.push('  ↑↓ 选择 · Enter 进入 · Esc 返回输入');
  return lines.join('\n');
}

export function formatWatch({ id, instance, session }, expanded = false) {
  const parts = (session.messages || []).filter((m) => m.role !== 'user')
    .flatMap((m) => (m.parts || []).filter((p) => p.type === 'tool' || (p.type === 'text' && p.text)));
  const recent = parts.slice(-(expanded ? 8 : 3));
  const lines = [`● T-${id} · ${clean(instance)} · ${clean(session.status)}`];
  if (parts.length > recent.length) lines.push(`  … ${parts.length - recent.length} 条更早的活动`);
  for (const p of recent) {
    if (p.type === 'tool') {
      lines.push(`  ⎿ ${trim(p.tool || '工具', 80)}${p.title ? ` · ${trim(p.title.replace(/\s+/g, ' '), expanded ? 300 : 100)}` : ''}${p.status ? ` (${clean(p.status)})` : ''}`);
      if (p.output) {
        const output = clean(p.output).split(/\r?\n/).filter(Boolean).slice(-(expanded ? 5 : 1));
        for (const line of output) lines.push(`    ${trim(line, expanded ? 240 : 100)}`);
      }
    } else {
      const text = clean(p.text).split(/\r?\n/).filter(Boolean).slice(-(expanded ? 4 : 1));
      for (const line of text) lines.push(`  ${trim(line, expanded ? 240 : 100)}`);
    }
  }
  if (!recent.length) lines.push('  等待执行器活动…');
  lines.push(expanded ? '  /watch collapse 收起 · /watch off 关闭' : '  /watch expand 展开 · /watch off 关闭');
  return lines.join('\n');
}
