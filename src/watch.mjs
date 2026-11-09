/** Compact, bounded live view; all strings are rendered as text, never terminal controls. */
const clean = (s) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const trim = (s, n) => { const v = clean(s); return v.length > n ? `…${v.slice(-n)}` : v; };

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
