/**
 * 线路配置:默认主线路是香港,备用按「美国直连 → 阿里→香港→美国」排;
 * 自己指定 --url 就不猜备用线路。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ALTS,
  DEFAULT_URL,
  defaultAltsFor,
  normalizeAlts,
  resolveSettings,
  upgradeSavedAlts,
} from '../src/config.mjs';

// 别读到本机真实的 ~/.sidekick/config.json 和 SIDEKICK_* 环境变量:里面存的旧备用线路会被升级成默认线路。
process.env.SIDEKICK_CONFIG = join(tmpdir(), `sidekick-config-test-${process.pid}-absent.json`);
for (const key of ['SIDEKICK_URL', 'SIDEKICK_ALT', 'SIDEKICK_ALTS']) delete process.env[key];

test('默认主线路自动带两条备用线路', () => {
  assert.deepEqual(defaultAltsFor(DEFAULT_URL), DEFAULT_ALTS);
  assert.deepEqual(defaultAltsFor('https://example.test/chat'), []);
  assert.deepEqual(resolveSettings({ url: DEFAULT_URL }).alts, DEFAULT_ALTS);
  assert.deepEqual(resolveSettings({ url: 'https://example.test/chat' }).alts, []);
});

test('旧配置里的单条杭州备用线路升级成新的两条默认线路', () => {
  assert.deepEqual(upgradeSavedAlts({ alt: 'http://47.96.64.66:18792' }), DEFAULT_ALTS);
  assert.deepEqual(upgradeSavedAlts({ alt: 'http://47.96.64.66:18792/chat' }), DEFAULT_ALTS);
  assert.deepEqual(upgradeSavedAlts({ alt: 'https://custom.test/chat' }), ['https://custom.test/chat']);
  assert.deepEqual(upgradeSavedAlts({ alts: ['https://a.test'] }), ['https://a.test']);
  assert.equal(upgradeSavedAlts({}), undefined);
});

test('--alt 可重复、也可逗号分隔,去重后保持顺序', () => {
  assert.deepEqual(normalizeAlts(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeAlts('a,b c\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(normalizeAlts(undefined), []);
  const settings = resolveSettings({ url: DEFAULT_URL, alt: ['https://one.test', 'https://two.test'] });
  assert.deepEqual(settings.alts, ['https://one.test', 'https://two.test']);
  assert.equal(settings.alt, 'https://one.test');
});

test('本机执行默认开,\u2014\u2014no-exec 和环境变量能关', () => {
  delete process.env.SIDEKICK_ALLOW_EXEC;
  assert.equal(resolveSettings({}).allowExec, true);
  assert.equal(resolveSettings({ noExec: true }).allowExec, false);
  process.env.SIDEKICK_ALLOW_EXEC = '0';
  assert.equal(resolveSettings({}).allowExec, false);
  assert.equal(resolveSettings({ noExec: false }).allowExec, false);
  process.env.SIDEKICK_ALLOW_EXEC = 'yes';
  assert.equal(resolveSettings({}).allowExec, true);
  delete process.env.SIDEKICK_ALLOW_EXEC;
});
