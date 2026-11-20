import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExecAgent, runCommand } from '../src/exec-agent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting');
}

test('runCommand returns exit code, stdout and stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-exec-'));
  const r = await runCommand('printf "hi\\n"; printf "oops\\n" >&2; pwd', { cwd: dir, timeoutMs: 5_000 });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.split('\n')[0], 'hi');
  assert.match(r.stderr, /oops/);
  assert.equal(r.stdout.includes(dir), true);
  assert.equal(r.truncated, false);
});

test('runCommand reports a nonzero exit and kills a timeout', async () => {
  const bad = await runCommand('exit 7', { timeoutMs: 5_000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 7);

  const slow = await runCommand('sleep 5', { timeoutMs: 120 });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 3_000, `took ${slow.durationMs}ms`);
});

test('runCommand truncates huge output at the byte limit', async () => {
  const r = await runCommand("head -c 5000 /dev/zero | tr '\\0' x", { timeoutMs: 5_000, maxOutputBytes: 128 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 128, `got ${r.stdout.length}`);
});

test('exec agent polls, runs, posts the result and writes an audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-agent-'));
  const logFile = join(dir, 'exec.log');
  const posted = [];
  let polls = 0;
  let runs = 0;
  const api = {
    async request(method, path, body) {
      if (path === 'v1/cli/poll') {
        polls += 1;
        if (polls === 1) return { commands: [{ id: 'cmd-1', command: 'printf "hello"', timeoutMs: 5_000, cwd: dir }] };
        await sleep(5);
        return { commands: [] };
      }
      if (path === 'v1/cli/result') {
        posted.push(body);
        return { ok: true };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const agent = createExecAgent({
    api,
    name: 'Test Mac',
    version: '9.9.9',
    pollWaitMs: 10,
    logFile,
    run: async (command, opts) => { runs += 1; return runCommand(command, opts); },
  });
  try {
    agent.start();
    await waitFor(() => posted.length === 1);
    assert.equal(runs, 1);
    assert.equal(posted[0].id, agent.id);
    assert.equal(posted[0].cmdId, 'cmd-1');
    assert.equal(posted[0].result.ok, true);
    assert.equal(posted[0].result.stdout, 'hello');
    assert.equal(existsSync(logFile), true);
    const logged = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.equal(logged.command, 'printf "hello"');
    assert.equal(logged.exitCode, 0);
  } finally {
    agent.stop();
  }
});

test('exec agent answers a redelivered command without running it twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-agent-dup-'));
  const posted = [];
  let polls = 0;
  let runs = 0;
  const api = {
    async request(_method, path, body) {
      if (path === 'v1/cli/poll') {
        polls += 1;
        // 同一条指令投两次:第一次真跑,第二次(回执丢了)只重发结果。
        if (polls <= 2) return { commands: [{ id: 'dup-1', command: 'true', timeoutMs: 5_000, cwd: dir }] };
        await sleep(5);
        return { commands: [] };
      }
      if (path === 'v1/cli/result') {
        posted.push(body);
        return { ok: true };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const agent = createExecAgent({ api, name: 'Dup', pollWaitMs: 10, logFile: join(dir, 'exec.log'), run: async (command, opts) => { runs += 1; return runCommand(command, opts); } });
  try {
    agent.start();
    await waitFor(() => posted.length === 2);
    assert.equal(runs, 1);
    assert.deepEqual(posted[0].result, posted[1].result);
  } finally {
    agent.stop();
  }
});

test('exec agent stops polling when disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-agent-off-'));
  let polls = 0;
  const api = {
    async request(_method, path) {
      if (path === 'v1/cli/poll') { polls += 1; await sleep(20); return { commands: [] }; }
      return { ok: true };
    },
  };
  const agent = createExecAgent({ api, name: 'Off', pollWaitMs: 10, logFile: join(dir, 'exec.log') });
  agent.start();
  await waitFor(() => polls > 0);
  agent.disable();
  const after = polls;
  await sleep(100);
  assert.ok(polls <= after + 1, `polls kept going: ${after} -> ${polls}`);
  assert.equal(agent.enabled, false);
});

test('exec agent heartbeats during commands without overlapping requests and stops on disable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-agent-heartbeat-'));
  let polls = 0;
  const pings = [];
  let releasePing;
  let finishRun;
  let resultPosted = false;
  const api = {
    async request(_method, path, body) {
      if (path === 'v1/cli/poll') {
        polls += 1;
        if (polls === 1) return { commands: [{ id: 'long-1', command: 'long command', timeoutMs: 60_000 }] };
        await sleep(10);
        return { commands: [] };
      }
      if (path === 'v1/cli/ping') {
        pings.push(body);
        // 模拟慢网络:未完成的报到不能重叠。
        if (pings.length === 1) await new Promise(resolve => { releasePing = resolve; });
        return { ok: true };
      }
      if (path === 'v1/cli/result') { resultPosted = true; return { ok: true }; }
      throw new Error(`unexpected ${path}`);
    },
  };
  const agent = createExecAgent({ api, heartbeatMs: 10, logFile: join(dir, 'exec.log'),
    run: () => new Promise(resolve => { finishRun = resolve; }),
  });
  try {
    agent.start();
    await waitFor(() => pings.length === 1);
    assert.equal(pings[0].agent.id, agent.id);
    assert.equal(pings[0].agent.allowExec, true);
    await sleep(40);
    assert.equal(pings.length, 1);
    releasePing();
    await waitFor(() => pings.length >= 2);
    finishRun({ ok: true, exitCode: 0, stdout: 'done', stderr: '', durationMs: 60 });
    await waitFor(() => resultPosted);
    const afterRun = pings.length;
    await sleep(40);
    assert.equal(pings.length, afterRun, 'heartbeats continued after command completion');
    agent.disable();
    await sleep(40);
    assert.equal(pings.length, afterRun, 'heartbeats continued after disable');
  } finally {
    releasePing?.();
    finishRun?.({ ok: false, exitCode: null, stdout: '', stderr: '' });
    agent.stop();
  }
});

test('exec agent stops command heartbeats when an active command is aborted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-agent-abort-'));
  let pings = 0;
  const api = {
    async request(_method, path) {
      if (path === 'v1/cli/poll') return { commands: [{ id: 'abort-1', command: 'long command', timeoutMs: 60_000 }] };
      if (path === 'v1/cli/ping') { pings += 1; return { ok: true }; }
      return { ok: true };
    },
  };
  const agent = createExecAgent({ api, heartbeatMs: 10, logFile: join(dir, 'exec.log'),
    run: (_command, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: 'interrupted' }), { once: true });
    }),
  });
  try {
    agent.start();
    await waitFor(() => pings >= 2);
    agent.disable();
    const after = pings;
    await sleep(50);
    assert.equal(pings, after);
    await waitFor(() => !agent.running);
  } finally {
    agent.stop();
  }
});
