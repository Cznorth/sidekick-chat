import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, unlink, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { SidekickApi } from '../src/api.mjs';
import { attachmentFromUrl, messageAttachments, saveAttachment } from '../src/attachments.mjs';
import { formatMessage, plainMessage } from '../src/format.mjs';

test('图片和文件显示不含凭据的 URL，纯文本也显示', () => {
  const message = { seq: 42, from: 'bot', ts: 0, text: '', images: ['x.png'], files: [{ name: 'f.pdf', title: '报告.pdf' }] };
  const api = new SidekickApi({ url: 'https://example.test/chat', token: 'secret' });
  const options = { attachmentUrl: (kind, name) => api.attachmentUrl(kind, name) };
  assert.deepEqual(messageAttachments(message).map((item) => item.kind), ['image', 'file']);
  for (const text of [formatMessage(message, options), plainMessage(message, [], options)]) {
    assert.match(text, /https:\/\/example.test\/chat\/v1\/team\/image\?name=x.png/);
    assert.match(text, /报告.pdf https:\/\/example.test\/chat\/v1\/team\/file\?name=f.pdf/);
    assert.doesNotMatch(text, /secret|附件 2|\/open 42/);
  }
});

test('只接受配置线路下的附件 URL，不将认证用于其他网站', () => {
  const api = new SidekickApi({ url: 'https://example.test/chat', alts: ['https://backup.test/chat'], token: 'secret' });
  assert.deepEqual(attachmentFromUrl(api, 'https://backup.test/chat/v1/team/file?name=a%20b.pdf'), { kind: 'file', name: 'a b.pdf', title: 'a b.pdf' });
  for (const url of ['https://evil.test/chat/v1/team/file?name=a', 'https://example.test/chat/v1/team/file?name=a&name=b', 'https://example.test/chat/v1/team/other?name=a', 'https://user@example.test/chat/v1/team/file?name=a']) {
    assert.throws(() => attachmentFromUrl(api, url));
  }
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
