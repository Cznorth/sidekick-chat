/**
 * 客户端和 chat World 之间的接口:鉴权、发送、推流补收,以及 `sidekick ask` 的端到端行为。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AuthError, SidekickApi } from '../src/api.mjs';
import { startFakeWorld } from './fake-world.mjs';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/sidekick.mjs', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'sidekick-cli-'));
const CONFIG = join(tmp, 'config.json');

test('plain CLI attaches a quoted image path and sends image-only payload', async () => {
  const world = await startFakeWorld();
  const path = join(tmp, 'screen shot.png');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  writeFileSync(path, png);
  try {
    const output = await new Promise((resolve, reject) => {
      let started = false;
      let quitting = false;
      let text = '';
      const child = execFile(process.execPath, [BIN, '--plain'], {
        env: { ...process.env, SIDEKICK_URL: world.url, SIDEKICK_TOKEN: world.token, SIDEKICK_CONFIG: CONFIG }, timeout: 8000,
      }, (err, stdout) => err ? reject(err) : resolve(stdout));
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (!started && text.includes('会话:')) { started = true; child.stdin.write(`/image "${path}"\n/send\n`); }
        if (!quitting && text.includes('收到:')) { quitting = true; child.stdin.write('/quit\n'); }
      });
    });
    assert.match(output, /待发送图片 1\/4/);
    const api = new SidekickApi({ url: world.url, token: world.token });
    const message = (await api.history('dm:sidekick')).messages.find((m) => m.from === 'user');
    assert.equal(message.text, '');
    assert.deepEqual(message.uploads, [{ mime: 'image/png', data: png.toString('base64') }]);
    assert.match(output, /test-image-0.png/);
  } finally { await world.close(); }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('令牌不对时报 AuthError,不是普通错误', async () => {
  const world = await startFakeWorld();
  try {
    const api = new SidekickApi({ url: world.url, token: 'wrong' });
    await assert.rejects(() => api.state(), (err) => err instanceof AuthError);
  } finally {
    await world.close();
  }
});

test('主线路连不上时自动换备用线路', async () => {
  const world = await startFakeWorld();
  try {
    // 1 号端口不会有人监听:模拟国内直连 TLS 被掐的情况。
    const api = new SidekickApi({ url: 'http://127.0.0.1:1', alt: world.url, token: world.token });
    const state = await api.state();
    assert.equal(state.primary, 'sidekick');
    assert.equal(api.base, world.url);
  } finally {
    await world.close();
  }
});

test('备用线路不认网页登录时,提示改用令牌而不是报密码错', async () => {
  const world = await startFakeWorld();
  try {
    const api = new SidekickApi({ url: 'http://127.0.0.1:1', alt: world.url, cookie: 'stale' });
    await assert.rejects(
      () => api.state(),
      (err) => err instanceof AuthError && /--token/.test(err.message),
    );
  } finally {
    await world.close();
  }
});

test('发一句、从推流里收到秘书的回复', async () => {
  const world = await startFakeWorld();
  try {
    const api = new SidekickApi({ url: world.url, token: world.token });
    const state = await api.state();
    assert.equal(state.primary, 'sidekick');

    const ctl = new AbortController();
    const got = [];
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => {
        ctl.abort();
        resolve();
      }, 3000);
      const streamTask = api.stream({
        after: 0,
        device: 'test',
        signal: ctl.signal,
        onEvent(event, payload) {
          if (event === 'hello') assert.equal(payload.state.primary, 'sidekick');
          if (event === 'message' && payload.from === 'sidekick') {
            got.push(payload);
            clearTimeout(timer);
            ctl.abort();
            resolve();
          }
        },
      });
      void streamTask;
    });

    // 等推流挂上再发,免得 hello 之前就发出去了。
    await new Promise((r) => setTimeout(r, 100));
    await api.send({ conv: 'dm:sidekick', text: '在吗', device: 'test' });
    await done;
    assert.equal(got.length, 1);
    assert.equal(got[0].text, '收到:在吗');
  } finally {
    await world.close();
  }
});

test('sidekick ask 一次性问一句:打印回复后退出', async () => {
  const world = await startFakeWorld();
  try {
    const { stdout } = await run(process.execPath, [BIN, 'ask', '--wait', '1', '今天有什么安排'], {
      env: {
        ...process.env,
        SIDEKICK_URL: world.url,
        SIDEKICK_TOKEN: world.token,
        SIDEKICK_CONFIG: CONFIG,
        NO_COLOR: '1',
      },
      timeout: 20_000,
    });
    assert.match(stdout, /收到:今天有什么安排/);
  } finally {
    await world.close();
  }
});

test('sidekick --version 和 --help 不用登录也能跑', async () => {
  const version = await run(process.execPath, [BIN, '--version'], { env: { ...process.env, SIDEKICK_CONFIG: CONFIG } });
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const help = await run(process.execPath, [BIN, '--help'], { env: { ...process.env, SIDEKICK_CONFIG: CONFIG } });
  assert.match(help.stdout, /sidekick login/);
});

test('interactive plain/pipe output has no escapes and prints an SSE echo only once', async () => {
  const world = await startFakeWorld();
  try {
    for (const flags of [[], ['--plain']]) {
      const text = flags.length ? '测试纯文本' : '测试管道';
      const output = await new Promise((resolve, reject) => {
        let stdout = '';
        let sent = false;
        const child = execFile(process.execPath, [BIN, ...flags], {
          env: { ...process.env, SIDEKICK_URL: world.url, SIDEKICK_TOKEN: world.token, SIDEKICK_CONFIG: CONFIG, FORCE_COLOR: '1' },
          timeout: 5000,
        }, (err, result) => err ? reject(err) : resolve(result));
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (!sent && stdout.includes('会话:')) {
            sent = true;
            child.stdin.write(`${text}\n`);
          }
          if (stdout.includes(`收到:${text}`)) child.stdin.write('/quit\n');
        });
      });
      assert.ok(!output.includes('\u001b'));
      assert.equal(output.split(`\n  ${text}\n`).length - 1, 1);
    }
  } finally {
    await world.close();
  }
});

test('没登录时交互模式给出明确提示,而不是崩栈', async () => {
  await run(process.execPath, [BIN, 'logout'], { env: { ...process.env, SIDEKICK_CONFIG: CONFIG } });
  const child = await run(process.execPath, [BIN, 'ask', '在吗'], {
    env: { ...process.env, SIDEKICK_CONFIG: CONFIG, SIDEKICK_URL: '', SIDEKICK_TOKEN: '' },
    timeout: 20_000,
  }).catch((err) => err);
  assert.equal(child.code, 2);
  assert.match(String(child.stderr), /还没登录/);
});

test('/usage is a local command in plain mode and shows all four quota sources', async () => {
  const world = await startFakeWorld();
  try {
    const output = await new Promise((resolve, reject) => {
      let sent = false;
      let quitting = false;
      let text = '';
      const child = execFile(process.execPath, [BIN, '--plain'], {
        env: { ...process.env, SIDEKICK_URL: world.url, SIDEKICK_TOKEN: world.token, SIDEKICK_CONFIG: CONFIG },
        timeout: 5000,
      }, (err, stdout) => err ? reject(err) : resolve(stdout));
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (!sent && text.includes('会话:')) { sent = true; child.stdin.write('/usage\n'); }
        if (!quitting && text.includes('Claude Docker 剩余')) { quitting = true; child.stdin.write('/quit\n'); }
      });
    });
    for (const name of ['OpenCode', 'Codex', 'Claude WSL', 'Claude Docker']) assert.ok(output.includes(`${name} 剩余`));
    const api = new SidekickApi({ url: world.url, token: world.token });
    assert.equal((await api.history('dm:sidekick')).messages.length, 0);
  } finally { await world.close(); }
});


test('plain CLI renders live activity and exposes it in /who and /conv', async () => {
  const world = await startFakeWorld();
  try {
    const output = await new Promise((resolve, reject) => {
      let text = ''; let emitted = false; let queried = false;
      const child = execFile(process.execPath, [BIN, '--plain'], {
        env: { ...process.env, SIDEKICK_URL: world.url, SIDEKICK_TOKEN: world.token, SIDEKICK_CONFIG: CONFIG }, timeout: 8000,
      }, (err, stdout) => err ? reject(err) : resolve(stdout));
      child.stdout.on('data', chunk => {
        text += chunk;
        if (!emitted && text.includes('尚无 LLM 活动记录')) {
          emitted = true;
          // 等 hello 到达后再推,模拟活跃会话内的更新。
          setTimeout(() => world.emit('activity', { bot: 'sidekick', at: Date.now(), text: '活动更新测试' }), 100);
        }
        if (!queried && text.includes('活动更新测试')) {
          queried = true; child.stdin.write('/who\n/conv\n/quit\n');
        }
      });
    });
    assert.match(output, /秘书: 最后活跃/);
    assert.ok(output.split('活动更新测试').length - 1 >= 3);
    assert.ok(!output.includes('\u001b'));
  } finally { await world.close(); }
});
