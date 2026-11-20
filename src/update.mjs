/**
 * 终端客户端的自更新:启动后悄悄去 npm registry 看有没有新版,有就下载、校验、
 * 解到 `~/.sidekick/cli/<版本>/`;下次启动由 `bin/sidekick.mjs` 直接跑新版本。
 *
 * 不覆盖全局 npm 目录:一是 `npm i -g` 可能装在只读位置,二是 npx 的缓存目录不确定。
 * 单独放一份在用户目录里,Windows / WSL / macOS 都一样。
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'sidekick-chat';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 30 * 60 * 1000;
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOG_LIMIT_BYTES = 256 * 1024;

/** 当前正在跑的这份代码所在的包目录。 */
export function ownPackageDir() {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** 当前版本;读不到就返回 0.0.0,宁可多查一次也不阻断启动。 */
export function ownVersion() {
  try {
    return String(JSON.parse(readFileSync(join(ownPackageDir(), 'package.json'), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** 自更新专用目录,测试里可以用 SIDEKICK_UPDATE_DIR 指到临时目录。 */
export function updateDir() {
  return process.env.SIDEKICK_UPDATE_DIR || join(homedir(), '.sidekick', 'cli');
}

export function registryUrl() {
  return String(process.env.SIDEKICK_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

function statePath() {
  return join(updateDir(), 'state.json');
}

function lockPath() {
  return join(updateDir(), 'update.lock');
}

function logPath() {
  return join(updateDir(), 'update.log');
}

/** 把版本拆成主版本号和预发布段;不是合法 semver 就返回 null。 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`版本号不合法:${left} / ${right}`);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const pa = a.pre[i];
    const pb = b.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = /^\d+$/.test(pa);
    const nb = /^\d+$/.test(pb);
    if (na && nb) return Number(pa) > Number(pb) ? 1 : -1;
    if (na) return -1;
    if (nb) return 1;
    return pa > pb ? 1 : -1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

export function readUpdateState() {
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeUpdateState(patch) {
  const file = statePath();
  mkdirSync(updateDir(), { recursive: true });
  const next = { ...readUpdateState(), ...patch };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    if (existsSync(file)) unlinkSync(file);
    renameSync(temp, file);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* 忽略 */ }
    throw err;
  }
  return next;
}

export function logUpdate(message) {
  try {
    mkdirSync(updateDir(), { recursive: true });
    const file = logPath();
    try {
      if (statSync(file).size > LOG_LIMIT_BYTES) writeFileSync(file, '');
    } catch { /* 还没日志 */ }
    appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  } catch {
    /* 写不了日志也不影响升级 */
  }
}

/** 已经下好、比当前版本新的那些版本,最多返回最新一个。 */
export function cachedUpdates() {
  const root = updateDir();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseVersion(entry.name)) continue;
    const dir = join(root, entry.name);
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name !== PACKAGE_NAME || pkg.version !== entry.name) continue;
      if (!existsSync(join(dir, 'bin', 'sidekick.mjs'))) continue;
      found.push({ version: entry.name, dir, bin: join(dir, 'bin', 'sidekick.mjs') });
    } catch {
      /* 下载了一半,忽略 */
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found;
}

export function newerCachedVersion(current = ownVersion()) {
  return cachedUpdates().find((item) => isNewer(item.version, current)) || null;
}

export function needsCheck(now = Date.now()) {
  if (process.env.SIDEKICK_NO_UPDATE === '1') return false;
  const state = readUpdateState();
  const interval = state.error ? ERROR_RETRY_MS : CHECK_INTERVAL_MS;
  return !state.checkedAt || now - Number(state.checkedAt) > interval;
}

/** 同一个用户目录只让一个进程下载/解压。返回释放函数;拿不到锁返回 null。 */
export function acquireUpdateLock() {
  mkdirSync(updateDir(), { recursive: true });
  const file = lockPath();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const info = JSON.parse(readFileSync(file, 'utf8'));
          if (info.pid === process.pid) unlinkSync(file);
        } catch {
          /* 已经被别人清掉 */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let info = {};
      try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 坏锁 */ }
      const age = Date.now() - Number(info.at || 0);
      if (info.pid && age < LOCK_STALE_MS && processAlive(info.pid)) return null;
      try { unlinkSync(file); } catch { /* 重试 */ }
    }
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function fetchLatest() {
  const registry = registryUrl();
  const url = `${registry}/${encodeURIComponent(PACKAGE_NAME)}/latest`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': `${PACKAGE_NAME}/${ownVersion()} (auto-update)`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm registry 返回 ${response.status}`);
  const meta = await response.json();
  if (String(meta?.name || '') !== PACKAGE_NAME) throw new Error('npm registry 返回的包名不对');
  const version = String(meta?.version || '');
  if (!parseVersion(version)) throw new Error('npm registry 返回的版本号不合法');
  const tarball = String(meta?.dist?.tarball || '');
  if (!tarball) throw new Error('npm registry 没有给下载地址');
  let parsed;
  try { parsed = new URL(tarball); } catch { throw new Error('npm registry 给的下载地址不合法'); }
  if (parsed.protocol !== 'https:' && !(registry.startsWith('http://') && parsed.protocol === 'http:')) {
    throw new Error('拒绝从非 HTTPS 地址下载更新');
  }
  return {
    version,
    tarball,
    integrity: String(meta?.dist?.integrity || ''),
    shasum: String(meta?.dist?.shasum || ''),
  };
}

function verifyTarball(bytes, meta) {
  const sha512 = meta.integrity.split(/\s+/).find((item) => item.startsWith('sha512-'));
  if (sha512) {
    const expected = sha512.slice('sha512-'.length);
    const actual = createHash('sha512').update(bytes).digest('base64');
    if (actual !== expected) throw new Error('下载的更新包校验失败(sha512)');
    return;
  }
  if (meta.shasum) {
    const actual = createHash('sha1').update(bytes).digest('hex');
    if (actual !== meta.shasum.toLowerCase()) throw new Error('下载的更新包校验失败(sha1)');
    return;
  }
  throw new Error('npm registry 没有提供校验值,拒绝安装');
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** 用 npm 把 package.json 里的生产依赖装进缓存目录,不然交互界面会找不到 pi-tui。 */
function installDependencies(dir) {
  const args = [
    'install',
    '--prefix', dir,
    '--omit=dev',
    '--ignore-scripts',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--registry', registryUrl(),
  ];
  const execPath = process.env.npm_execpath;
  const result = execPath
    ? spawnSync(process.execPath, [execPath, ...args], { encoding: 'utf8', windowsHide: true })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  if (result.error || result.status !== 0) {
    throw new Error(`安装更新依赖失败:${result.error?.message || (result.stderr || '').trim() || `退出码 ${result.status}`}`);
  }
}

function missingDependencies(dir, pkg) {
  const optional = new Set(Object.keys(pkg.optionalDependencies || {}));
  return Object.keys(pkg.dependencies || {}).filter((name) => {
    if (optional.has(name)) return false;
    return !existsSync(join(dir, 'node_modules', name, 'package.json'));
  });
}

function verifyDependencies(dir, pkg) {
  const missing = missingDependencies(dir, pkg);
  if (missing.length) throw new Error(`更新包缺少依赖 ${missing.join(', ')}`);
}

/**
 * 补齐当前这份代码自己的生产依赖。
 *
 * 0.3.0 的更新器只会解包、不会装依赖,它下出来的 0.3.1 第一次启动时靠这里补;
 * 以后新版本由新版更新器直接装好,这里通常一次就过。
 */
export function ensureOwnDependencies() {
  const dir = ownPackageDir();
  let pkg;
  try {
    pkg = readPackage(dir);
  } catch {
    return false;
  }
  const missing = missingDependencies(dir, pkg);
  if (!missing.length) return true;
  try {
    installDependencies(dir);
    verifyDependencies(dir, pkg);
    logUpdate(`已补齐依赖:${missing.join(', ')}`);
    return true;
  } catch (err) {
    logUpdate(`补齐依赖失败:${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function extractWithNpm(version, tempRoot) {
  const prefix = join(tempRoot, 'npm');
  const args = [
    'install',
    '--prefix', prefix,
    '--no-save',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry', registryUrl(),
    `${PACKAGE_NAME}@${version}`,
  ];
  const execPath = process.env.npm_execpath;
  const result = execPath
    ? spawnSync(process.execPath, [execPath, ...args], { encoding: 'utf8', windowsHide: true })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  if (result.error || result.status !== 0) {
    throw new Error(`npm 下载更新失败:${result.error?.message || (result.stderr || '').trim() || `退出码 ${result.status}`}`);
  }
  return join(prefix, 'node_modules', PACKAGE_NAME);
}

async function downloadUpdate(meta) {
  const tempRoot = join(updateDir(), `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  try {
    const response = await fetch(meta.tarball, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`下载更新失败:npm registry 返回 ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_TARBALL_BYTES) throw new Error('更新包太大,拒绝下载');
    verifyTarball(bytes, meta);

    const archive = join(tempRoot, 'package.tgz');
    writeFileSync(archive, bytes, { mode: 0o600 });
    const extractDir = join(tempRoot, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const result = spawnSync('tar', ['-xzf', archive, '-C', extractDir], { encoding: 'utf8', windowsHide: true });
    let packageDir = join(extractDir, 'package');
    if (result.error || result.status !== 0) {
      logUpdate(`tar 解压失败,改用 npm 下载:${result.error?.message || (result.stderr || '').trim() || result.status}`);
      packageDir = extractWithNpm(meta.version, tempRoot);
    }

    const pkg = readPackage(packageDir);
    if (pkg.name !== PACKAGE_NAME || pkg.version !== meta.version) {
      throw new Error(`下载到的包不对:${pkg.name}@${pkg.version}`);
    }
    if (!existsSync(join(packageDir, 'bin', 'sidekick.mjs'))) throw new Error('更新包里没有 bin/sidekick.mjs');
    if (!existsSync(join(packageDir, 'src', 'update.mjs')) || !existsSync(join(packageDir, 'src', 'update-worker.mjs'))) {
      throw new Error('更新包里没有自更新模块');
    }

    const target = join(updateDir(), meta.version);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(packageDir, target);
    try {
      if (Object.keys(pkg.dependencies || {}).length) installDependencies(target);
      verifyDependencies(target, pkg);
      try { chmodSync(join(target, 'bin', 'sidekick.mjs'), 0o755); } catch { /* Windows 上没意义 */ }
    } catch (err) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* 留给下次重试 */ }
      throw err;
    }
    return target;
  } finally {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响 */ }
  }
}

function cleanupOldVersions(keepVersion) {
  const current = ownVersion();
  for (const item of cachedUpdates()) {
    if (item.version === keepVersion || item.version === current) continue;
    if (!isNewer(keepVersion, item.version)) continue;
    try { rmSync(item.dir, { recursive: true, force: true }); } catch { /* Windows 上可能有进程在用 */ }
  }
}

/**
 * 检查并下载更新。默认拿锁,拿不到就返回 busy;`force` 忽略 6 小时间隔。
 * 返回状态:current(已是最新)、ready(新版早已下好)、installed(这次下好了)、busy。
 */
export async function checkForUpdate({ force = false, lock = true } = {}) {
  const current = ownVersion();
  const release = lock ? acquireUpdateLock() : () => {};
  if (!release) {
    return { status: 'busy', current, latest: readUpdateState().latest || '', cached: Boolean(newerCachedVersion(current)) };
  }
  try {
    const cached = newerCachedVersion(current);
    if (!force && !needsCheck()) {
      return {
        status: cached ? 'ready' : 'current',
        current,
        latest: readUpdateState().latest || cached?.version || current,
        installed: cached?.version || '',
        cached: Boolean(cached),
      };
    }

    const meta = await fetchLatest();
    if (!isNewer(meta.version, current)) {
      writeUpdateState({ checkedAt: Date.now(), latest: meta.version, error: null });
      return { status: cached ? 'ready' : 'current', current, latest: meta.version, installed: cached?.version || '', cached: Boolean(cached) };
    }
    if (cached && compareVersions(cached.version, meta.version) >= 0) {
      writeUpdateState({ checkedAt: Date.now(), latest: meta.version, error: null });
      return { status: 'ready', current, latest: meta.version, installed: cached.version, cached: true };
    }

    await downloadUpdate(meta);
    writeUpdateState({
      checkedAt: Date.now(),
      latest: meta.version,
      installed: meta.version,
      installedAt: Date.now(),
      error: null,
    });
    cleanupOldVersions(meta.version);
    logUpdate(`已下载 ${meta.version},下次启动生效(当前 ${current})`);
    return { status: 'installed', current, latest: meta.version, installed: meta.version, cached: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { writeUpdateState({ checkedAt: Date.now(), error: message }); } catch { /* 状态写不了也不影响 */ }
    logUpdate(`自动更新失败:${message}`);
    throw err;
  } finally {
    release();
  }
}

/** 启动时拉起一个脱离终端的后台进程去查更新,不拖慢当前这一轮。 */
export function spawnUpdateWorker() {
  try {
    const worker = fileURLToPath(new URL('./update-worker.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SIDEKICK_UPDATE_WORKER: '1' },
    });
    child.unref();
    return true;
  } catch (err) {
    logUpdate(`无法启动更新检查:${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
