import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { ccwebBase, createQuotaMonitor, formatQuota, quotaRows } from '../src/quota.mjs';

test('ccweb URL preserves the host and proxy prefix, and maps the direct port', () => {
  assert.equal(ccwebBase('https://example.test/chat/'), 'https://example.test/ccweb');
  assert.equal(ccwebBase('https://example.test/team/chat'), 'https://example.test/team/ccweb');
  assert.equal(ccwebBase('http://localhost:18792'), 'http://localhost:18794');
  assert.equal(ccwebBase(''), '');
  assert.throws(() => ccwebBase('https://example.test/custom'));
});

test('used percentages convert to remaining; missing, stale and offline data stay explicit', () => {
  const now = Date.now();
  const rows = quotaRows({
    opencode: { data: { sampledAt: new Date(now).toISOString(), windows: [{ label: '5h', percent: 23 }, { label: '周', percent: null }] } },
    codex: { failed: true, data: { sampledAt: new Date(now - 20 * 60_000).toISOString(), windows: [{ label: '周', percent: 100 }] } },
    claude: { data: { agents: [{ name: 'WSL', engine: 'claude-code', online: false, usage: { updatedAt: now, windows: [{ label: '5h', leftPct: 12, resetsAt: now + 3600_000 }] } }] } },
  }, now);
  assert.equal(rows[0].windows[0].left, 77);
  assert.equal(rows[0].windows[1].left, null);
  assert.equal(rows[1].windows[0].left, 0);
  assert.equal(rows[1].stale, true);
  const text = formatQuota(rows, { detail: true });
  assert.match(text, /Claude WSL 剩余 5h 12%.*重置.*离线/);
  assert.match(text, /Claude Docker 剩余 未知.*尚无采样/);
  assert.match(text, /刷新失败，保留旧值/);
});

test('quota polling uses existing authenticated routes, preserves good sources on failures, and does not overlap', async () => {
  let fail = false;
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    if (req.url === '/chat/v1/codex/status' && fail) { res.writeHead(503); res.end('{}'); return; }
    const body = {
      '/chat/v1/opencode/quota': { sampledAt: new Date().toISOString(), windows: [{ label: '5h', percent: fail ? 40 : 20 }] },
      '/chat/v1/codex/status': { loggedIn: true, sampledAt: new Date().toISOString(), windows: [{ label: '周', percent: 30 }] },
      '/ccweb/v1/agents': { agents: [{ name: 'Docker', engine: 'claude-code', online: true, usage: { updatedAt: Date.now(), windows: [{ label: '5h', leftPct: 90 }] } }] },
    }[req.url];
    assert.ok(body, req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const updates = [];
  const monitor = createQuotaMonitor({ url: `http://127.0.0.1:${server.address().port}/chat`, token: 'synthetic-token' }, (rows) => updates.push(rows));
  try {
    const first = monitor.refresh();
    assert.equal(monitor.refresh(), first);
    assert.equal((await first)[0].windows[0].left, 80);
    assert.equal(calls, 3);
    fail = true;
    const rows = await monitor.refresh();
    assert.equal(calls, 6);
    assert.equal(rows[0].windows[0].left, 60);
    assert.equal(rows[1].windows[0].left, 70);
    assert.equal(rows[1].stale, true);
    assert.equal(updates.length, 6);
    monitor.stop();
    await monitor.refresh();
    assert.equal(calls, 6);
  } finally {
    monitor.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
