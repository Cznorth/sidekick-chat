import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function messageAttachments(message) {
  return [
    ...(message.images || []).map((name) => ({ kind: 'image', name, title: name })),
    ...(message.files || []).map((file) => ({ kind: 'file', name: file.name, title: file.title || file.name })),
  ];
}

export async function saveAttachment(api, attachment, { signal } = {}) {
  const data = await api.attachment(attachment.kind, attachment.name, { signal });
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-attachment-'));
  const title = String(attachment.title || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'attachment';
  const path = join(directory, title);
  await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  return path;
}

export function openAttachment(path) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
