/**
 * 终端客户端的本地配置:`~/.sidekick/config.json`(权限 600)。
 * 只存服务器地址、登录凭据(设备令牌或网页登录 Cookie)和上次用的会话,不存密码明文。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://hkv4.cznorth.cn/chat';
/** 主线路连不上时自动换的备用线路(杭州阿里云 frps 把 chat World 的 18792 开在公网)。 */
export const DEFAULT_ALT = 'http://47.96.64.66:18792';

export function configPath() {
  return process.env.SIDEKICK_CONFIG || join(homedir(), '.sidekick', 'config.json');
}

export function readConfig() {
  const file = configPath();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return typeof raw === 'object' && raw ? raw : {};
  } catch {
    return {};
  }
}

export function writeConfig(cfg) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // Windows 上 mode 只影响只读位,这里补一次尽力而为的收紧。
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 某些文件系统不支持,忽略 */
  }
}

export function clearConfig() {
  const file = configPath();
  if (existsSync(file)) writeFileSync(file, '{}\n', { mode: 0o600 });
}

/**
 * 把命令行参数、环境变量和配置文件合成一份可用设置。优先级:参数 > 环境变量 > 配置文件。
 * 设备令牌和 Cookie 二者取其一;都没有时返回的 `loggedIn` 为 false,由调用方引导登录。
 */
export function resolveSettings(flags = {}) {
  const saved = readConfig();
  const url = String(flags.url || process.env.SIDEKICK_URL || saved.url || DEFAULT_URL).trim();
  const alt = String(flags.alt || process.env.SIDEKICK_ALT || saved.alt || defaultAltFor(url)).trim();
  const token = String(flags.token || process.env.SIDEKICK_TOKEN || saved.token || '').trim();
  const cookie = String(process.env.SIDEKICK_COOKIE || saved.cookie || '').trim();
  const device = String(flags.device || process.env.SIDEKICK_DEVICE || saved.device || '终端').trim();
  return {
    url: stripTrailingSlash(url),
    alt: stripTrailingSlash(alt),
    token,
    cookie,
    device,
    conv: flags.conv || saved.conv || '',
    loggedIn: Boolean(token || cookie),
    saved,
  };
}

export function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

/** 用默认的主线路时自动带上已知的备用线路;自己指定 `--url` 就只走那一条。 */
export function defaultAltFor(url) {
  return stripTrailingSlash(url) === DEFAULT_URL ? DEFAULT_ALT : '';
}

/** WebUI 的登录接口在站点根上,不在 `/chat/` 这类前缀下面。 */
export function authOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return stripTrailingSlash(url);
  }
}
