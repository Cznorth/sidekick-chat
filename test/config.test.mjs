/**
 * 线路配置:默认主线路是香港,备用按「美国直连 → 阿里→香港→美国」排;
 * 自己指定 --url 就不猜备用线路。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ALTS,
  DEFAULT_URL,
  defaultAltsFor,
  normalizeAlts,
  resolveSettings,
  upgradeSavedAlts,
} from '../src/config.mjs';

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
