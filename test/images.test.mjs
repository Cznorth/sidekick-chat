import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageUpload, clipboardImage, MAX_IMAGE_BYTES } from '../src/images.mjs';

const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
test('image uploads enforce backend types and size limit', () => {
  assert.deepEqual(imageUpload(png), { mime: 'image/png', data: png.toString('base64') });
  assert.throws(() => imageUpload(Buffer.from('not an image')), /只支持/);
  assert.throws(() => imageUpload(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /6 MB/);
});
test('Windows clipboard uses STA and passes PNG bytes without shell interpolation', async () => {
  const image = await clipboardImage({ platform: 'win32', run: async (cmd, args, options) => {
    assert.equal(cmd, 'powershell.exe');
    assert.ok(args.includes('-STA'));
    assert.equal(options.windowsHide, true);
    assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /GetImage/);
    return { stdout: png.toString('base64') + '\r\n' };
  } });
  assert.equal(image.data, png.toString('base64'));
});
test('clipboard failure provides actionable feedback', async () => {
  await assert.rejects(clipboardImage({ platform: 'win32', run: async () => { throw new Error('empty'); } }), /先复制图片/);
  await assert.rejects(clipboardImage({ platform: 'darwin', run: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /pngpaste/);
});
