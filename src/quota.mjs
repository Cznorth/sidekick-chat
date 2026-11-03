import { SidekickApi } from './api.mjs';

/** Same host and credentials as chat; proxy prefix or the standard direct port. */
export function ccwebBase(base) {
  if (!base) return '';
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat')) url.pathname = path.slice(0, -5) + '/ccweb';
  else if (!path && url.port === '18792') url.port = '18794';
  else throw new Error('无法推导 ccweb 地址');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

const percentage = (value) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(Math.max(0, Math.min(100, value))) : null;
const timestamp = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
};
const usedWindows = (windows) => (Array.isArray(windows) ? windows : []).map((w) => ({
  label: w.label || w.id || '?',
  left: percentage(typeof w.percent === 'number' ? 100 - w.percent : null),
  resetsAt: timestamp(w.resetsAt),
}));

export function quotaRows(values, now = Date.now()) {
  const { opencode, codex, claude } = values;
  const row = (label, value, windows, at, note = '') => ({
    label, windows, at: timestamp(at),
    stale: Boolean(value?.failed || value?.data?.stale || timestamp(at) && now - timestamp(at) > 10 * 60_000),
    note: value?.failed ? (value.data ? '刷新失败，保留旧值' : '暂不可用') : note,
  });
  const oc = opencode?.data;
  const cx = codex?.data;
  const rows = [
    row('OpenCode', opencode, usedWindows(oc?.windows), oc?.sampledAt, oc?.stale ? '缓存' : ''),
    row('Codex', codex, usedWindows(cx?.windows), cx?.sampledAt, cx?.loggedIn === false ? '未登录' : ''),
  ];
  const agents = (Array.isArray(claude?.data?.agents) ? claude.data.agents : []).filter((a) => a.engine === 'claude-code');
  // Keep both requested channels visible even before their first report.
  for (const name of ['WSL', 'Docker']) if (!agents.some((a) => a.name === name)) agents.push({ name });
  for (const agent of agents) {
    rows.push(row(`Claude ${agent.name}`, claude,
      (Array.isArray(agent.usage?.windows) ? agent.usage.windows : []).map((w) => ({
        label: w.label || w.key || '?', left: percentage(w.leftPct), resetsAt: timestamp(w.resetsAt),
      })), agent.usage?.updatedAt, agent.online === false ? '离线' : ''));
  }
  return rows;
}

const localTime = (at) => {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function formatQuota(rows, { detail = false } = {}) {
  return rows.map((r) => {
    const windows = r.windows.map((w) => `${w.label} ${w.left === null ? '?' : w.left + '%'}${detail && w.resetsAt ? `（${localTime(w.resetsAt)} 重置）` : ''}`).join(' / ');
    const notes = [r.note, r.stale ? '旧数据' : '', r.at ? `${localTime(r.at)} 采样` : '尚无采样'].filter(Boolean);
    return `${r.label} 剩余 ${windows || '未知'} · ${notes.join(' · ')}`;
  }).join('\n');
}

/** Independent failures preserve each source's last good snapshot. Requests are made only by the usage command. */
export function createQuotaReader(settings, { api = new SidekickApi(settings), agentsApi } = {}) {
  const values = {};
  const ctl = new AbortController();
  let pending;
  let stopped = false;
  let ccApi = agentsApi;
  const sources = {
    opencode: () => api.request('GET', 'v1/opencode/quota', undefined, { signal: ctl.signal }),
    codex: () => api.request('GET', 'v1/codex/status', undefined, { signal: ctl.signal }),
    claude: () => {
      ccApi ??= new SidekickApi({ ...settings, url: ccwebBase(settings.url), alt: ccwebBase(settings.alt) });
      return ccApi.request('GET', 'v1/agents', undefined, { signal: ctl.signal });
    },
  };
  function refresh() {
    if (stopped) return Promise.resolve(quotaRows(values));
    if (pending) return pending;
    pending = (async () => {
      await Promise.allSettled(Object.entries(sources).map(async ([key, fetch]) => {
        try { values[key] = { data: await fetch(), failed: false }; }
        catch { values[key] = { ...values[key], failed: true }; }
      }));
      return quotaRows(values);
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    refresh,
    stop() { stopped = true; ctl.abort(); },
  };
}
