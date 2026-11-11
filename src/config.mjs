/**
 * 终端客户端的本地配置:`~/.sidekick/config.json`(权限 600)。
 * 只存服务器地址、登录凭据(设备令牌或网页登录 Cookie)和上次用的会话,不存密码明文。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://hkv4.cznorth.cn/chat';
/**
 * 主线路(香港)连不上时按顺序换的备用线路:
 * 1. 美国直连(kiro.ch66.top 的证书在美机上,`/sk-us` 前缀转到各 World);
 * 2. 阿里云 frps → 香港 OpenResty → 美国(和主线路同一个后端,只是入口在杭州)。
 */
export const DEFAULT_ALTS = [
  'https://kiro.ch66.top/sk-us/chat',
  'http://47.96.64.66:18792/chat',
];
/** 旧配置里的单条备用线路;仍然是「阿里云 → 美国」,现在中间也经香港。 */
export const DEFAULT_ALT = DEFAULT_ALTS[1];

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
  const rawAlts = flags.alts ?? flags.alt ?? process.env.SIDEKICK_ALTS ?? process.env.SIDEKICK_ALT
    ?? upgradeSavedAlts(saved) ?? defaultAltsFor(url);
  const alts = normalizeAlts(rawAlts).map(stripTrailingSlash);
  const token = String(flags.token || process.env.SIDEKICK_TOKEN || saved.token || '').trim();
  const cookie = String(process.env.SIDEKICK_COOKIE || saved.cookie || '').trim();
  const device = String(flags.device || process.env.SIDEKICK_DEVICE || saved.device || '终端').trim();
  return {
    url: stripTrailingSlash(url),
    /** 旧代码只认单条备用线路,保留第一个。 */
    alt: alts[0] || '',
    alts,
    token,
    cookie,
    device,
    conv: flags.conv || saved.conv || '',
    loggedIn: Boolean(token || cookie),
    saved,
  };
}

/** 旧版本登录时会自动把单条杭州备用线路写进 `alt`;读到它就升级成新的两条默认线路。 */
export function upgradeSavedAlts(saved) {
  if (Array.isArray(saved.alts)) return saved.alts;
  if (!saved.alt) return undefined;
  const old = stripTrailingSlash(String(saved.alt));
  if (old === 'http://47.96.64.66:18792' || old === 'http://47.96.64.66:18792/chat') return [...DEFAULT_ALTS];
  return [saved.alt];
}

/** `--alt` 可重复,也可写成逗号/空格/换行分隔;数组要原样保留。 */
export function normalizeAlts(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return [...new Set(list.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

export function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

/** 用默认的主线路时自动带上已知的备用线路;自己指定 `--url` 就只走那一条。 */
export function defaultAltsFor(url) {
  return stripTrailingSlash(url) === DEFAULT_URL ? [...DEFAULT_ALTS] : [];
}

/** 兼容旧调用:只要第一条备用线路。 */
export function defaultAltFor(url) {
  return defaultAltsFor(url)[0] || '';
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
