import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, unlink, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { SidekickApi } from '../src/api.mjs';
import { messageAttachments, saveAttachment } from '../src/attachments.mjs';
import { formatMessage, plainMessage } from '../src/format.mjs';

test('附件显示和编号包含图片、文件，纯文本不会丢失附件', () => {
  const message = { seq: 42, from: 'bot', ts: 0, text: '', images: ['x.png'], files: [{ name: 'f.pdf', title: '报告.pdf' }] };
  assert.deepEqual(messageAttachments(message).map((item) => item.kind), ['image', 'file']);
  assert.match(formatMessage(message), /附件 2.*报告.pdf/);
  assert.match(formatMessage(message), /\/open 42/);
  assert.match(plainMessage(message), /报告.pdf/);
});

test('附件下载携带鉴权且保存到安全文件名', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    assert.equal(req.url, '/v1/team/file?name=a%20b.pdf');
    res.end('test data');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = new SidekickApi({ url: `http://127.0.0.1:${server.address().port}`, token: 'secret' });
  let path;
  try {
    path = await saveAttachment(api, { kind: 'file', name: 'a b.pdf', title: '../报告.pdf' });
    assert.equal(await readFile(path, 'utf8'), 'test data');
    assert.match(path, /_报告\.pdf$/);
  } finally {
    if (path) { await unlink(path); await rmdir(dirname(path)); }
    await new Promise((resolve) => server.close(resolve));
  }
});
