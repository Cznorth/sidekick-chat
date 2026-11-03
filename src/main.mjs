/**
 * 终端客户端的主流程:`sidekick` 进交互对话,`sidekick login` 存凭据,`sidekick ask "…"` 一次性问一句。
 *
 * 它只是 chat World 的又一个客户端,和手机 App、网页版共用同一份会话和未读,
 * 不新增任何后端接口(见 packages/world-chat/src/world.ts 的 `startHub`)。
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuthError, SidekickApi, loginWithPassword } from './api.mjs';
import {
  DEFAULT_ALT,
  DEFAULT_URL,
  clearConfig,
  configPath,
  readConfig,
  resolveSettings,
  stripTrailingSlash,
  writeConfig,
} from './config.mjs';
import {
  dayLabel,
  formatConversation,
  formatMessage,
  colorsEnabled,
  oneLine,
  paint,
  plainMessage,
} from './format.mjs';
import { ask, askPassword } from './prompt.mjs';
import { createQuotaReader, formatQuota } from './quota.mjs';

const PACKAGE_VERSION = (() => {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(readFileSync(file, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const HELP = `Sidekick 终端客户端 ${PACKAGE_VERSION}

用法:
  sidekick                     和秘书对话(进去后输入一行回车发一条)
  sidekick "今天有什么安排"      问一句,等回复打印完就退出
  sidekick ask --wait 20 "…"   同上,收到第一条后最多再等 20 秒后续消息
  sidekick login               登录(网页密码或设备令牌)
  sidekick logout              删掉本机保存的登录态
  sidekick help                这份说明

参数:
  --url <地址>      服务器地址,默认 ${DEFAULT_URL}
  --alt <地址>      备用线路,主线路连不上时自动换,默认 ${DEFAULT_ALT}
  --token <令牌>    设备令牌(部署 .env 的 SIDEKICK_DEVICE_TOKEN),跳过密码登录
  --password <密码> 网页登录密码(不给就在终端里问)
  --conv <会话>     指定会话:id、名字或 /conv 列表里的序号,默认和秘书的私聊
  --device <名字>   这台机器的署名,默认「终端」
  --wait <秒>       一次性模式:收到第一条后再等多久算说完,默认 6
  --json            一次性模式:每条消息输出一行 JSON
  --no-color        不上色
  --plain           纯文本:不上色、不重画输入行(老终端/管道/日志里用)
  -h, --help        这份说明
  -v, --version     版本

进交互后可用 /help 看命令,/conv 列会话,/to 切换,Ctrl-C 退出。

环境变量(优先于配置文件):SIDEKICK_URL、SIDEKICK_ALT、SIDEKICK_TOKEN、SIDEKICK_PASSWORD、SIDEKICK_DEVICE、SIDEKICK_COOKIE。
配置放在 ${configPath()}(权限 600)。`;

/** 命令行参数解析:node 自带的 parseArgs,不引第三方依赖。 */
function parseFlags(argv) {
  const flags = { positional: [] };
  const takesValue = new Set(['url', 'alt', 'token', 'password', 'conv', 'device', 'wait']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      flags.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      flags.version = true;
      continue;
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--no-color') {
      flags.noColor = true;
      continue;
    }
    if (arg === '--plain') {
      flags.plain = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!takesValue.has(name)) throw new Error(`不认识的参数:--${name}`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`--${name} 缺一个值`);
      flags[name] = value;
      continue;
    }
    flags.positional.push(arg);
  }
  return flags;
}

const stdout = (text) => process.stdout.write(`${text}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** 登录:有令牌就用令牌,否则拿网页密码换 Cookie,最后都用 `/v1/team/state` 验一次。 */
async function loginCommand(flags) {
  const current = resolveSettings(flags);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let url = stripTrailingSlash(String(flags.url || current.url || DEFAULT_URL));
  if (interactive && !flags.url) {
    url = stripTrailingSlash(await ask(`服务器地址 [${current.url}]:`, { fallback: current.url }));
  }

  let token = String(flags.token || '').trim();
  let cookie = '';
  if (!token) {
    let password = String(flags.password || process.env.SIDEKICK_PASSWORD || '');
    if (!password) {
      if (!interactive) throw new Error('没有终端可问密码:请用 --password 或 --token');
      password = await askPassword('网页登录密码(和网页版同一个 CORTICO_WEB_PASSWORD):');
      if (!password) throw new Error('没输入密码');
    }
    cookie = await loginWithPassword(url, password);
  }

  const api = new SidekickApi({ url, alt: current.alt, token, cookie });
  const state = await api.state();
  const primary = state.bots.find((b) => b.primary);
  const cfg = { ...readConfig(), url, alt: current.alt, device: current.device || '终端', savedAt: new Date().toISOString() };
  if (token) {
    cfg.token = token;
    delete cfg.cookie;
  } else {
    cfg.cookie = cookie;
    delete cfg.token;
  }
  writeConfig(cfg);
  stdout(`登录成功:${url}`);
  stdout(`主 Bot:${primary?.name || state.primary};会话 ${state.conversations.length} 个。凭据存在 ${configPath()}`);
  return { url, token, cookie };
}

/** 一次性模式:发一句,把回复打印完就退出,方便脚本里用。 */
async function askOnce(flags, text) {
  const settings = resolveSettings(flags);
  if (!settings.loggedIn) throw new AuthError('还没登录,先运行 sidekick login');
  const api = new SidekickApi(settings);
  const state = await api.state();
  const conv = pickConv(state, settings.conv);
  const idleMs = Math.max(1, Number(flags.wait || 6) || 6) * 1000;
  const sent = await api.send({ conv, text, device: settings.device });

  const ctl = new AbortController();
  const got = [];
  let idleTimer = null;
  let guardTimer = null;
  let finishing = false;
  const done = new Promise((resolve) => {
    const finish = () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(idleTimer);
      clearTimeout(guardTimer);
      ctl.abort();
      resolve();
    };
    ctl.signal.addEventListener('abort', finish, { once: true });
    // 一直没回复也别吊着:默认 5 分钟(按 idle 时间的两倍放宽)。
    guardTimer = setTimeout(finish, Math.max(120_000, idleMs * 2));
  });

  api
    .stream({
      after: sent.seq,
      device: settings.device,
      signal: ctl.signal,
      onEvent(event, payload) {
        if (event === 'message') {
          if (payload.conv !== conv || payload.from === 'user') return;
          got.push(payload);
          if (flags.json) stdout(JSON.stringify(payload));
          else stdout(plainMessage(payload, state.bots));
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => ctl.abort(), idleMs);
        } else if (event === 'busy' && conv.startsWith('dm:') && payload.busy === false && got.length > 0) {
          // 私聊里这一轮结束了,不用再等 idle;群里别的成员还在忙,只认 idle。
          ctl.abort();
        }
      },
    })
    .catch((err) => {
      if (!ctl.signal.aborted) fail(`推流出错:${err instanceof Error ? err.message : String(err)}`);
    });

  await done;
  if (got.length === 0) {
    fail('没等到回复。检查服务器是否在跑,或者用 sidekick 进交互看看。');
    return;
  }
}

/** 按 id、名字或列表序号找一个会话;找不到返回 undefined。 */
export function findConv(state, wanted) {
  const ref = String(wanted || '').trim();
  if (!ref) return undefined;
  const byId = state.conversations.find((c) => c.id === ref);
  if (byId) return byId;
  const byTitle = state.conversations.find((c) => c.title === ref);
  if (byTitle) return byTitle;
  const index = Number(ref);
  if (Number.isInteger(index) && index > 0 && index <= state.conversations.length) return state.conversations[index - 1];
  return undefined;
}

/** 按 id、名字或列表序号挑会话;挑不到就退回和主 Bot 的私聊。 */
export function pickConv(state, wanted) {
  const primaryConv = `dm:${state.primary}`;
  const found = findConv(state, wanted);
  if (found) return found.id;
  if (state.conversations.some((c) => c.id === primaryConv)) return primaryConv;
  return state.conversations[0]?.id ?? primaryConv;
}

/** 交互模式。 */
async function startChat(flags) {
  let settings = resolveSettings(flags);
  if (!settings.loggedIn) {
    if (!process.stdin.isTTY) throw new AuthError('还没登录,先运行 sidekick login');
    await loginCommand({ ...flags, url: flags.url || settings.url });
    settings = resolveSettings(flags);
  }

  let api = new SidekickApi(settings);
  let state;
  try {
    state = await api.state();
  } catch (err) {
    if (err instanceof AuthError) {
      if (!process.stdin.isTTY) throw new AuthError('登录态已失效,重新运行 sidekick login');
      await loginCommand({ ...flags, url: settings.url });
      settings = resolveSettings(flags);
      api = new SidekickApi(settings);
      state = await api.state();
    } else {
      throw err;
    }
  }

  // 老终端(不认 ANSI)和管道里别用转义序列:重画输入行会留下「[K」这类垃圾。
  const vt = Boolean(process.stdout.isTTY && process.stdin.isTTY) && process.env.TERM !== 'dumb' && !flags.plain && process.env.SIDEKICK_PLAIN !== '1';
  const color = flags.noColor || !vt ? false : colorsEnabled();
  const convTitle = (id) => state.conversations.find((c) => c.id === id)?.title || id;
  const convOf = (id) => state.conversations.find((c) => c.id === id);
  let convId = pickConv(state, settings.conv);
  let latest = state.latest || 0;
  let everConnected = false;
  const displayed = new Set();
  const ctl = new AbortController();
  let rl = null;
  let closed = false;
  let ui = null;
  let streamTask = Promise.resolve();
  const quotas = createQuotaReader(settings);

  const out = (text) => {
    if (ui) ui.out(text);
    else process.stdout.write(`${text}\n`);
  };
  const typing = (on) => ui?.typing(on);

  const printMessage = (message) => {
    const options = { bots: state.bots, color, imageUrl: (name) => api.imageUrl(name) };
    if (ui) ui.message(message, options);
    else out(formatMessage(message, options));
  };
  if (vt) {
    const { createChatUI } = await import('./tui.mjs');
    ui = createChatUI({ color, onSubmit: (text) => {
      queue.push(() => text.startsWith('/') ? handleSlash(text) : sendText(text));
      void drain();
    }, onQuit: () => shutdown(0) });
  }

  async function printHistory(limit = 20) {
    const body = await api.history(convId, limit);
    let day = '';
    for (const m of body.messages) {
      const d = dayLabel(m.ts);
      if (d !== day) {
        out(paint(color, 'gray', `──── ${d} ────`));
        day = d;
      }
      printMessage(m);
    }
    latest = Math.max(latest, body.latest || 0);
    if (body.latest) api.read(convId, body.latest).catch(() => {});
    if (body.messages.length === 0) out(paint(color, 'gray', '(这里还没有消息)'));
  }

  const primary = state.bots.find((b) => b.primary);
  out(`${paint(color, 'bold', `Sidekick · ${primary?.name || state.primary}`)} ${paint(color, 'gray', settings.url)}`);
  if (settings.conv && !findConv(state, settings.conv)) {
    out(paint(color, 'yellow', `找不到会话「${settings.conv}」,先用「${convTitle(convId)}」;/conv 看全部`));
  }
  out(paint(color, 'gray', `会话:${convTitle(convId)} · /help 看命令,/conv 列会话,Ctrl-C 退出`));
  await printHistory(30);

  function applyState(next) {
    if (!next) return;
    state = next;
    if (!convOf(convId)) {
      ui?.clearDrafts();
      convId = pickConv(state, '');
    }
  }

  function onMessage(m) {
    latest = Math.max(latest, m.seq || 0);
    typing(false);
    if (displayed.has(m.seq)) return;
    displayed.add(m.seq);
    if (displayed.size > 1000) displayed.delete(displayed.values().next().value);
    if (m.conv !== convId) {
      if (m.from !== 'user') {
        out(paint(color, 'gray', `· ${convTitle(m.conv)} 有新消息(${oneLine(m.text, 40) || '图片'}),/to 切过去`));
      }
      return;
    }
    printMessage(m);
    if (typeof m.seq === 'number') api.read(convId, m.seq).catch(() => {});
  }

  streamTask = api
    .stream({
      after: latest,
      device: settings.device,
      signal: ctl.signal,
      onStatus: (kind) => {
        if (kind === 'closed' || kind === 'error') ui?.clearDrafts();
        // 只在「连着的时候断了」和「重新接上」各说一句,退避重试期间不刷屏。
        if (kind === 'open') {
          if (everConnected) out(paint(color, 'green', '已重新连上'));
          everConnected = true;
        } else if (kind === 'error' && everConnected) {
          everConnected = false;
          out(paint(color, 'red', '连接断了,正在重连…'));
        }
      },
      onEvent(event, payload) {
        if (event === 'hello' || event === 'state') applyState(payload.state ?? payload);
        else if (event === 'message') onMessage(payload);
        else if (event === 'draft' && ui) {
          // End frames have no conversation; remove only the matching sender/id.
          if (payload.end || payload.conv === convId) ui.draft(payload, { bots: state.bots, color });
          else ui.draft({ ...payload, end: true }, { bots: state.bots, color });
        }
        else if (event === 'busy') typing(Boolean(payload.busy));
      },
    })
    .catch((err) => {
      if (ctl.signal.aborted) return;
      out(err instanceof AuthError ? '登录态已失效,重新运行 sidekick login' : `推流出错:${err.message}`);
      shutdown(1);
    });

  function switchConv(next) {
    ui?.clearDrafts();
    convId = next;
    const cfg = { ...readConfig(), url: settings.url, conv: convId, device: settings.device };
    writeConfig(cfg);
    out(paint(color, 'green', `→ ${convTitle(convId)}`));
    return printHistory(30);
  }

  async function handleSlash(line) {
    const [raw, ...rest] = line.slice(1).trim().split(/\s+/);
    const cmd = (raw || '').toLowerCase();
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help':
      case '?':
        out([
          '/conv            列出会话',
          '/to <序号|名字>  切换会话',
          '/history [n]     重印最近 n 条(默认 20)',
          '/who             名册和连接状态',
          '/usage           查询额度，查看剩余比例和重置时间',
          '/clear           清屏',
          '/quit            退出(也可以 Ctrl-C)',
          '直接输入文字就是发给当前会话。',
        ].join('\n'));
        return;
      case 'quit':
      case 'exit':
      case 'q':
        shutdown(0);
        return;
      case 'conv':
      case 'convs':
      case 'ls':
        out(
          state.conversations
            .map((c, i) => formatConversation(c, i + 1, { bots: state.bots, current: convId }))
            .join('\n') || '(还没有会话)',
        );
        return;
      case 'to':
      case 'switch':
        if (!arg) {
          out('用法:/to <序号或名字>,先 /conv 看一眼');
          return;
        }
        await switchConv(pickConv(state, arg));
        return;
      case 'history':
      case 'h':
        await printHistory(Math.max(1, Number(arg) || 20));
        return;
      case 'who':
        out(
          state.bots
            .map((b) => `${b.primary ? '*' : ' '}${b.name}(${b.id}) ${b.status}${b.busy ? ' 正在忙' : ''} — ${b.role || '无专长'}`)
            .join('\n'),
        );
        return;
      case 'usage':
      case 'quota':
        out(formatQuota(await quotas.refresh(), { detail: true }));
        return;
      case 'clear':
        if (ui) ui.clear();
        else out('(清屏已跳过:纯文本模式下不动终端)');
        return;
      default:
        out(paint(color, 'red', `不认识的命令:/${cmd}(/help 看命令)`));
    }
  }

  const queue = [];
  let busy = false;
  async function drain() {
    if (busy) return;
    const next = queue.shift();
    if (next === undefined) return;
    busy = true;
    try {
      await next();
    } catch (err) {
      out(paint(color, 'red', err instanceof Error ? err.message : String(err)));
    } finally {
      busy = false;
      void drain();
    }
  }

  async function sendText(text) {
    const res = await api.send({ conv: convId, text, device: settings.device });
    latest = Math.max(latest, res.seq);
    if (displayed.has(res.seq)) return;
    displayed.add(res.seq);
    printMessage({ seq: res.seq, conv: convId, ts: Date.now(), from: 'user', text });
  }

  if (ui) {
    ui.start();
  } else {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      queue.push(() => (text.startsWith('/') ? handleSlash(text) : sendText(text)));
      void drain();
    });
    rl.on('SIGINT', () => shutdown(0));
    rl.on('close', () => {
      if (!closed) shutdown(0);
    });
  }

  function shutdown(code = 0) {
    if (closed) return;
    closed = true;
    typing(false);
    quotas.stop();
    ui?.stop();
    ctl.abort();
    try {
      rl?.close();
    } catch {
      /* 已经关了 */
    }
    process.exitCode = code;
    void streamTask.catch(() => {});
    // 让事件循环自己收尾:Windows 上在 TLS 句柄还没关完时就 process.exit(),
    // 会让 libuv 报「!(handle->flags & UV_HANDLE_CLOSING)」直接崩掉。
    // 万一有句柄赖着不放,1.5 秒后强退。
    setTimeout(() => process.exit(code), 1500).unref();
  }
}

export async function run(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    fail(`${err.message}\n\n${HELP}`);
    return;
  }
  if (flags.help) {
    stdout(HELP);
    return;
  }
  if (flags.version) {
    stdout(PACKAGE_VERSION);
    return;
  }
  if (flags.noColor) process.env.NO_COLOR = '1';

  const command = flags.positional[0];
  const rest = flags.positional.slice(1);

  process.on('unhandledRejection', (err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });

  try {
    if (command === 'help') {
      stdout(HELP);
      return;
    }
    if (command === 'login') {
      await loginCommand(flags);
      return;
    }
    if (command === 'logout') {
      clearConfig();
      stdout(`已经删掉本机保存的登录态(${configPath()})`);
      return;
    }
    if (command === 'ask') {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('用法:sidekick ask "要说的话"');
      await askOnce(flags, text);
      return;
    }
    if (command) {
      // 没有子命令就当成一句话发出去:sidekick "今天有什么安排"
      await askOnce(flags, flags.positional.join(' ').trim());
      return;
    }
    await startChat(flags);
  } catch (err) {
    if (err instanceof AuthError) {
      fail(`${err.message}`);
      process.exitCode = 2;
      return;
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}
