import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageUpload, clipboardImage, imageFile, wslPath, MAX_IMAGE_BYTES } from '../src/images.mjs';

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
test('WSL reads the Windows clipboard through powershell.exe, not WSLg wl-paste', async () => {
  const calls = [];
  const image = await clipboardImage({ platform: 'linux', wsl: true, env: { WAYLAND_DISPLAY: 'wayland-0' }, run: async (cmd) => {
    calls.push(cmd);
    return { stdout: png.toString('base64') + '\r\n' };
  } });
  assert.deepEqual(calls, ['powershell.exe']);
  assert.equal(image.data, png.toString('base64'));
});
test('WSL without interop falls back to Linux clipboard tools; empty Windows clipboard is not retried', async () => {
  const calls = [];
  const image = await clipboardImage({ platform: 'linux', wsl: true, env: { WAYLAND_DISPLAY: 'wayland-0' }, run: async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'powershell.exe') throw Object.assign(new Error(), { code: 'ENOENT' });
    assert.deepEqual(args, ['--type', 'image/png']);
    return { stdout: png };
  } });
  assert.deepEqual(calls, ['powershell.exe', 'wl-paste']);
  assert.equal(image.mime, 'image/png');
  calls.length = 0;
  await assert.rejects(clipboardImage({ platform: 'linux', wsl: true, env: {}, run: async (cmd) => { calls.push(cmd); throw Object.assign(new Error('exit 2'), { code: 2 }); } }), /先复制图片/);
  assert.deepEqual(calls, ['powershell.exe']);
  await assert.rejects(clipboardImage({ platform: 'linux', wsl: true, env: {}, run: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /interop/);
});
test('WSL /image accepts Windows paths', async () => {
  assert.equal(wslPath('D:\\图片\\截图.png'), '/mnt/d/图片/截图.png');
  assert.equal(wslPath('C:/a/b.png'), '/mnt/c/a/b.png');
  assert.equal(wslPath('/home/u/a.png'), '/home/u/a.png');
  await assert.rejects(imageFile('"Z:\\no\\such.png"', { wsl: true }), (err) => /mnt[\\/]z[\\/]no[\\/]such\.png$/.test(err.path));
});
