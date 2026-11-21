import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeWorld } from './fake-world.mjs';

test('startup and messages after input never automatically acknowledge the conversation', async () => {
  const world = await startFakeWorld();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sidekick.mjs', import.meta.url)), '--plain', '--no-exec'], {
    env: { ...process.env, SIDEKICK_URL: world.url, SIDEKICK_TOKEN: world.token,
      SIDEKICK_CONFIG: join(mkdtempSync(join(tmpdir(), 'sk-read-')), 'config.json') }, stdio: 'pipe',
  });
  let output = '';
  child.stdout.on('data', c => output += c);
  async function until(fn) {
    for (let i = 0; i < 100; i++) { if (fn()) return; await delay(30); }
    assert.fail('timed out: ' + output);
  }
  try {
    await until(() => output.includes('会话:'));
    await delay(150);
    assert.equal(world.reads.length, 0);
    world.emit('message', { seq: 1, conv: 'dm:sidekick', from: 'sidekick', ts: Date.now(), text: 'first-incoming' });
    await until(() => output.includes('first-incoming'));
    assert.equal(world.reads.length, 0);
    child.stdin.write('/who\n');
    await until(() => world.reads.length === 1);
    assert.equal(world.reads[0].seq, 1);
    world.emit('message', { seq: 2, conv: 'dm:sidekick', from: 'sidekick', ts: Date.now(), text: 'after-input' });
    await until(() => output.includes('after-input'));
    await delay(150);
    assert.equal(world.reads.length, 1);
  } finally { child.kill(); await world.close(); }
});
