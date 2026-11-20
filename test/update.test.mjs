/**
 * 自更新:版本比较、已下载版本的挑选,以及对着一个假的 npm registry 走完
 * 「查版本 → 下载 → 校验 → 解压到 ~/.sidekick/cli/<版本>」。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  checkForUpdate,
  compareVersions,
  newerCachedVersion,
  ownVersion,
  readUpdateState,
} from '../src/update.mjs';
import { listenSafe } from './listen.mjs';

const tempDirs = [];
const saved = {};
for (const key of ['SIDEKICK_UPDATE_DIR', 'SIDEKICK_REGISTRY', 'SIDEKICK_NO_UPDATE']) saved[key] = process.env[key];

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-update-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeTarball(version) {
  const root = tempDir();
  const pkg = join(root, 'package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sidekick-chat', version, bin: { sidekick: 'bin/sidekick.mjs' } }));
  writeFileSync(join(pkg, 'bin', 'sidekick.mjs'), '#!/usr/bin/env node\nconsole.log("ok");\n');
  writeFileSync(join(pkg, 'src', 'update.mjs'), 'export const ok = true;\n');
  writeFileSync(join(pkg, 'src', 'update-worker.mjs'), '// worker\n');
  const archive = join(root, 'package.tgz');
  const result = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return readFileSync(archive);
}

async function fakeRegistry({ version, tarball, integrity }) {
  const server = createServer((req, res) => {
    if (req.url === '/sidekick-chat/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: 'sidekick-chat',
        version,
        dist: { tarball: `http://127.0.0.1:${server.address().port}/package.tgz`, integrity },
      }));
      return;
    }
    if (req.url === '/package.tgz') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tarball);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await listenSafe(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

test('版本比较认得出补丁、预发布和不同位数', () => {
  assert.equal(compareVersions('0.3.0', '0.2.21'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0-beta.1', '0.3.0'), -1);
  assert.equal(compareVersions('0.3.0-beta.2', '0.3.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('只挑比当前新的、完整的缓存版本', () => {
  const root = tempDir();
  process.env.SIDEKICK_UPDATE_DIR = root;
  const make = (version, valid = true) => {
    const dir = join(root, version);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sidekick-chat', version }));
    if (valid) writeFileSync(join(dir, 'bin', 'sidekick.mjs'), '');
  };
  make('0.3.0');
  make('0.4.0');
  make('0.5.0', false);
  make('not-a-version');
  assert.equal(newerCachedVersion('0.3.0').version, '0.4.0');
  assert.equal(newerCachedVersion('0.4.0'), null);
});

test('查到新版后下载、校验、解压;之后启动能挑到它', async () => {
  const root = tempDir();
  process.env.SIDEKICK_UPDATE_DIR = root;
  const tarball = makeTarball('9.9.9');
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const { server, url } = await fakeRegistry({ version: '9.9.9', tarball, integrity });
  process.env.SIDEKICK_REGISTRY = url;
  try {
    const result = await checkForUpdate({ force: true });
    assert.equal(result.status, 'installed');
    assert.equal(result.installed, '9.9.9');
    assert.equal(newerCachedVersion('0.3.0').version, '9.9.9');
    assert.equal(JSON.parse(readFileSync(join(root, '9.9.9', 'package.json'), 'utf8')).version, '9.9.9');
    assert.equal(readUpdateState().latest, '9.9.9');
  } finally {
    server.close();
  }
});

test('校验值对不上就拒绝安装', async () => {
  const root = tempDir();
  process.env.SIDEKICK_UPDATE_DIR = root;
  const tarball = makeTarball('9.9.9');
  const { server, url } = await fakeRegistry({
    version: '9.9.9',
    tarball,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  });
  process.env.SIDEKICK_REGISTRY = url;
  try {
    await assert.rejects(() => checkForUpdate({ force: true }), /校验失败/);
    assert.equal(newerCachedVersion('0.3.0'), null);
  } finally {
    server.close();
  }
});

test('入口启动时切到已下载的新版;关掉更新就不切', () => {
  const root = tempDir();
  const dir = join(root, '9.9.9');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sidekick-chat', version: '9.9.9' }));
  writeFileSync(join(dir, 'bin', 'sidekick.mjs'), 'console.log("delegated-ok");\n');
  const bin = fileURLToPath(new URL('../bin/sidekick.mjs', import.meta.url));
  const env = { ...process.env, SIDEKICK_UPDATE_DIR: root };
  delete env.SIDEKICK_NO_UPDATE;
  const delegated = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env });
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout.trim(), 'delegated-ok');

  const disabled = spawnSync(process.execPath, [bin, '--version'], {
    encoding: 'utf8',
    env: { ...env, SIDEKICK_NO_UPDATE: '1' },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), ownVersion());
});

test('已经是最新版就不下载', async () => {
  const root = tempDir();
  process.env.SIDEKICK_UPDATE_DIR = root;
  const version = ownVersion();
  const tarball = makeTarball(version);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const { server, url } = await fakeRegistry({ version, tarball, integrity });
  process.env.SIDEKICK_REGISTRY = url;
  try {
    const result = await checkForUpdate({ force: true });
    assert.equal(result.status, 'current');
    assert.equal(newerCachedVersion(version), null);
  } finally {
    server.close();
  }
});
