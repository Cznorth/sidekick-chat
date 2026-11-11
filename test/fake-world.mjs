/**
 * 测试用的假 chat World:只实现终端客户端用到的几个接口(state / history / send / read / stream),
 * 行为照 packages/world-chat/src/world.ts,好让客户端能脱网跑。
 */
import { createServer } from 'node:http';

export const TOKEN = 'test-token';

export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function startFakeWorld({ token = TOKEN, primary = 'sidekick', botName = '秘书', context } = {}) {
  const messages = [];
  const streams = new Set();
  let seq = 0;
  let agentPolls = 0;

  const state = () => ({
    primary,
    bots: [{ id: primary, name: botName, role: '秘书', emoji: '🗂', primary: true, enabled: true, status: 'online', busy: false, ...(context ? { context } : {}) }],
    conversations: [
      {
        id: `dm:${primary}`,
        kind: 'dm',
        title: botName,
        members: [primary],
        createdAt: 0,
        createdBy: 'user',
        read: 0,
        unread: 0,
        last: messages.at(-1) ?? null,
      },
    ],
    latest: seq,
  });

  const push = (message) => {
    seq = Math.max(seq, message.seq);
    messages.push(message);
    for (const res of streams) res.write(sseFrame('message', message));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/ccweb/v1/agents/task') {
      agentPolls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instance: 'Codex', session: { id: 'c1', status: 'running', messages: [{ id: 'live', role: 'assistant', parts: [{ type: 'tool', tool: 'run_command', title: 'echo hi', status: 'running', output: agentPolls > 1 ? 'first\nsecond' : 'first' }] }] } }));
      return;
    }
    if (url.pathname.startsWith('/chat/')) url.pathname = url.pathname.slice(5);
    if (url.pathname === '/v1/team/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state()));
      return;
    }
    if (url.pathname === '/v1/team/history') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ conv: url.searchParams.get('conv'), messages, read: 0, latest: seq }));
      return;
    }
    if (url.pathname === '/v1/team/send') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seq += 1;
        const images = body.images?.map((_, i) => `test-image-${i}.png`);
        const sent = { seq, conv: body.conv, ts: Date.now(), from: 'user', text: body.text, device: body.device, images, uploads: body.images };
        push(sent);
        // 模拟秘书:隔一拍回一句。
        setTimeout(() => {
          seq += 1;
          push({ seq, conv: body.conv, ts: Date.now(), from: primary, text: `收到:${body.text}`, model: 'codex/gpt-5.5' });
        }, 30);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ seq: sent.seq, conv: sent.conv, images }));
      });
      return;
    }
    if (url.pathname === '/v1/team/read') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ conv: url.searchParams.get('conv'), read: seq }));
      return;
    }
    if (url.pathname === '/v1/team/stream') {
      const after = Number(url.searchParams.get('after') || 0) || 0;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write('retry: 3000\n\n');
      res.write(sseFrame('hello', { state: state() }));
      for (const m of messages) if (m.seq > after) res.write(sseFrame('message', m));
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    state,
    emit: (event, data) => { for (const res of streams) res.write(sseFrame(event, data)); },
    close: () =>
      new Promise((resolve) => {
        for (const res of streams) res.end();
        streams.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
