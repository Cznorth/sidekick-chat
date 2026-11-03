/**
 * 客户端和 chat World 之间的接口:鉴权、发送、推流补收,以及 `sidekick ask` 的端到端行为。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('没登录时交互模式给出明确提示,而不是崩栈', async () => {
  await run(process.execPath, [BIN, 'logout'], { env: { ...process.env, SIDEKICK_CONFIG: CONFIG } });
  const child = await run(process.execPath, [BIN, 'ask', '在吗'], {
    env: { ...process.env, SIDEKICK_CONFIG: CONFIG, SIDEKICK_URL: '', SIDEKICK_TOKEN: '' },
    timeout: 20_000,
  }).catch((err) => err);
  assert.equal(child.code, 2);
  assert.match(String(child.stderr), /还没登录/);
});
