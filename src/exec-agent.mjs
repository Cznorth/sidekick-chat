/**
 * 秘书在运行 CLI 的这台机器上执行命令的通道。
 *
 * CLI 在 NAT 后面,服务器连不过来,所以由 CLI 长轮询取指令(`POST /v1/cli/poll`),
 * 在本机以当前用户身份跑完,再把退出码和输出回传(`POST /v1/cli/result`)。
 * 只在交互模式启动;关掉窗口就不再常驻。默认开,`/exec off` 或 `--no-exec` 关。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { arch, homedir, hostname, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { AuthError } from './api.mjs';

/** 单路输出最多回传这么多字节,避免一条命令把上下文撑爆。 */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** 审计日志里留一小段输出,够查是什么情况,又不至于把日志写成全文。 */
const MAX_LOGGED_OUTPUT = 4000;
/** 服务端一次挂 15 秒;请求本身 20 秒超时,留出余量。 */
const POLL_WAIT_MS = 15_000;
/** 执行时不能轮询取活,单独报到以免超过服务端的 45 秒在线窗口。 */
const HEARTBEAT_MS = 15_000;
/** 记住最近的回执,服务端重投时原样再回一次,不重复执行。 */
const CACHE_SIZE = 50;

export function executionLogPath() {
  return join(homedir(), '.sidekick', 'exec.log');
}

/** 追加一条本机执行审计。写不进去不影响命令本身。 */
export function logExecution(entry, file = executionLogPath()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* 没有家目录或只读文件系统:命令照跑,日志能写多少算多少 */
  }
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function shellCommand(command, platformName) {
  if (platformName === 'win32') {
    // 先切 UTF-8 代码页,否则中文 Windows 上的输出会被 Node 按 UTF-8 读成乱码。
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] };
  }
  return { file: '/bin/sh', args: ['-lc', command] };
}

function killTree(child, platformName) {
  if (!child.pid) return;
  if (platformName === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
  }
}

/**
 * 在本机跑一条命令。不抛异常:超时、起不来、被中断都折成 `{ok:false,...}`。
 * `spawnImpl` 只给测试替换用。
 */
export function runCommand(command, {
  cwd,
  timeoutMs = 60_000,
  platformName = platform(),
  spawnImpl = spawn,
  signal,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const { file, args } = shellCommand(command, platformName);
    const output = { stdout: '', stderr: '' };
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let forceTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ durationMs: Date.now() - started, ...result });
    };

    const child = spawnImpl(file, args, {
      cwd: expandHome(cwd) || undefined,
      env: process.env,
      windowsHide: true,
      detached: platformName !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      killTree(child, platformName);
      finish({ ok: false, exitCode: null, stdout: output.stdout, stderr: output.stderr, truncated, timedOut, error: 'interrupted' });
    };

    const collect = (which, chunk) => {
      const text = chunk.toString('utf8');
      const room = maxOutputBytes - Buffer.byteLength(output[which], 'utf8');
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (Buffer.byteLength(text, 'utf8') > room) {
        output[which] += text.slice(0, Math.max(0, room));
        truncated = true;
      } else {
        output[which] += text;
      }
    };

    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => {
      finish({ ok: false, exitCode: null, stdout: output.stdout, stderr: output.stderr, truncated, timedOut, error: error.message });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: typeof code === 'number' ? code : null, stdout: output.stdout, stderr: output.stderr, truncated, timedOut });
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platformName);
      // 进程不理会 SIGKILL 或被系统挂住时别让这次调用永远悬着。
      forceTimer = setTimeout(() => {
        finish({ ok: false, exitCode: null, stdout: output.stdout, stderr: output.stderr, truncated, timedOut: true, error: 'timed out' });
      }, 3000);
      forceTimer.unref?.();
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function firstLine(text, max = 160) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 建立这台 CLI 的执行身份并开始轮询。返回的对象给主循环开/关、查状态用。
 * `out` 是往终端打印一行;`api.request` 复用 CLI 已登录的线路和重试。
 */
export function createExecAgent({
  api,
  name,
  version = '0.0.0',
  enabled = true,
  cwd = process.cwd(),
  out = () => {},
  logFile = executionLogPath(),
  pollWaitMs = POLL_WAIT_MS,
  heartbeatMs = HEARTBEAT_MS,
  run = runCommand,
} = {}) {
  const id = randomUUID();
  const recent = new Map();
  let allowed = enabled !== false;
  let controller = null;
  let task = null;
  let warnedAt = 0;

  const meta = () => ({
    id,
    name: String(name || 'CLI').slice(0, 100),
    hostname: hostname().slice(0, 100),
    platform: platform(),
    release: release(),
    arch: arch(),
    version,
    allowExec: allowed,
    cwd: String(cwd || '').slice(0, 300),
  });

  const postResult = (cmdId, result) => api.request('POST', 'v1/cli/result', { id, cmdId, result }, { signal: controller?.signal });

  async function loop(signal) {
    let delay = 1000;
    while (allowed && !signal.aborted) {
      try {
        const reply = await api.request('POST', 'v1/cli/poll', { agent: meta(), wait: pollWaitMs }, { signal });
        delay = 1000;
        for (const cmd of Array.isArray(reply?.commands) ? reply.commands : []) {
          if (!allowed) break;
          const cached = recent.get(cmd.id);
          if (cached) {
            await postResult(cmd.id, cached).catch(() => {});
            continue;
          }
          out(`[秘书执行] $ ${firstLine(cmd.command)}`);
          let pinging = false;
          const heartbeat = setInterval(() => {
            if (pinging || signal.aborted) return;
            pinging = true;
            void api.request('POST', 'v1/cli/ping', { agent: meta() }, { signal })
              .catch(() => {})
              .finally(() => { pinging = false; });
          }, heartbeatMs);
          heartbeat.unref?.();
          let result;
          try {
            result = await run(cmd.command, {
              cwd: cmd.cwd,
              timeoutMs: Math.max(1000, Number(cmd.timeoutMs) || 60_000),
              signal,
            });
          } finally {
            clearInterval(heartbeat);
          }
          const payload = {
            ok: result.ok === true,
            exitCode: result.exitCode ?? null,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            truncated: result.truncated === true,
            durationMs: result.durationMs || 0,
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
          logExecution({
            id: cmd.id,
            command: cmd.command,
            cwd: cmd.cwd || cwd,
            exitCode: payload.exitCode,
            durationMs: payload.durationMs,
            truncated: payload.truncated,
            timedOut: payload.timedOut === true,
            stdout: payload.stdout.slice(-MAX_LOGGED_OUTPUT),
            stderr: payload.stderr.slice(-MAX_LOGGED_OUTPUT),
          }, logFile);
          recent.set(cmd.id, payload);
          if (recent.size > CACHE_SIZE) recent.delete(recent.keys().next().value);
          out(`[执行${payload.ok ? '完成' : '结束'}] exit ${payload.exitCode ?? '?'} · ${(payload.durationMs / 1000).toFixed(1)}s${payload.timedOut ? ' · 超时' : ''}${payload.truncated ? ' · 输出已截断' : ''}`);
          await postResult(cmd.id, payload);
        }
      } catch (error) {
        if (signal.aborted || !allowed) return;
        if (error instanceof AuthError) {
          out('CLI 执行通道:登录态已失效,执行通道已停');
          return;
        }
        // 断网时安静退避,别每十几秒往对话里刷一行。
        if (Date.now() - warnedAt > 5 * 60_000) {
          warnedAt = Date.now();
          out(`CLI 执行通道暂时连不上,稍后重试:${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(delay, signal);
        delay = Math.min(15_000, delay * 2);
      }
    }
  }

  const start = () => {
    if (!allowed || task) return;
    controller = new AbortController();
    const signal = controller.signal;
    task = loop(signal).finally(() => {
      if (controller?.signal === signal) controller = null;
      task = null;
    });
  };
  const stop = () => {
    allowed = false;
    controller?.abort();
    controller = null;
  };

  return {
    id,
    get enabled() { return allowed; },
    get running() { return Boolean(task); },
    start,
    stop,
    enable() {
      if (allowed) return;
      allowed = true;
      if (task) void task.finally(() => { if (allowed) start(); });
      else start();
    },
    disable() {
      if (allowed) stop();
    },
  };
}
