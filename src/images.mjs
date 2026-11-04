import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const exec = promisify(execFile);
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** WSL 里跑的是 Linux 版 Node,但剪贴板在 Windows 那边:WSLg 的 Wayland 剪贴板不同步图片。 */
export function isWsl(env = process.env) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { return false; }
}

/** WSL 里粘进来的 Windows 路径(D:\图片\a.png)换成 /mnt/d/图片/a.png。 */
export function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}

export function imageUpload(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片必须在 1 字节到 6 MB 之间');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? 'image/gif'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (!mime) throw new Error('只支持 PNG、JPEG、GIF、WebP 图片');
  return { mime, data: bytes.toString('base64') };
}

export async function imageFile(path, { wsl = process.platform === 'linux' && isWsl() } = {}) {
  const unquoted = path.replace(/^("|')(.*)\1$/, '$2');
  const file = wsl ? wslPath(unquoted) : unquoted;
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('请选择不超过 6 MB 的图片文件');
  return imageUpload(await readFile(file));
}

/** Read the local OS clipboard; never run clipboard text as a command. */
export async function clipboardImage({ platform = process.platform, run = exec, wsl = platform === 'linux' && isWsl(), env = process.env } = {}) {
  const options = { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $img) { exit 2 }; $stream = New-Object IO.MemoryStream; try { $img.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose(); $img.Dispose() }`;
  const windows = async () => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
    return imageUpload(Buffer.from(String(stdout).trim(), 'base64'));
  };
  const linux = async () => {
    const command = env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip';
    const args = command === 'wl-paste' ? ['--type', 'image/png'] : ['-selection', 'clipboard', '-t', 'image/png', '-o'];
    const { stdout } = await run(command, args, { ...options, encoding: 'buffer' });
    return imageUpload(Buffer.from(stdout));
  };
  try {
    if (platform === 'win32') return await windows();
    if (platform === 'darwin') {
      const { stdout } = await run('pngpaste', ['-'], { ...options, encoding: 'buffer' });
      return imageUpload(Buffer.from(stdout));
    }
    if (wsl) {
      // 先读 Windows 剪贴板(截图、复制的图都在那边);WSL 关了 interop 才退回 Linux 工具。
      try { return await windows(); } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
      }
    }
    return await linux();
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(wsl
      ? 'WSL 里调不到 powershell.exe(interop 可能关了),也没装 wl-clipboard / xclip;可用 /image 图片路径(Windows 路径也行)'
      : '缺少剪贴板工具：macOS 安装 pngpaste，Linux 安装 wl-clipboard 或 xclip；也可用 /image 图片路径');
    throw new Error('无法读取剪贴板图片，请先复制图片，或用 /image 图片路径');
  }
}
