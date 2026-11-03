/**
 * 终端里的交互输入:普通提问(带回车默认值)和遮掉回显的密码输入。
 */
import { createInterface } from 'node:readline';

/** 问一句,拿一行答案;直接回车就用 `fallback`。 */
export async function ask(question, { fallback = '', input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(question, resolve);
    });
    const trimmed = answer.trim();
    return trimmed || fallback;
  } finally {
    rl.close();
  }
}

/** 读密码:终端里按 * 显示(不公开长度以外的信息),管道输入时直接读一行。 */
export function askPassword(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    const rl = createInterface({ input, output, terminal: false });
    return new Promise((resolve) => {
      rl.once('line', (line) => {
        rl.close();
        resolve(line.replace(/\r$/, ''));
      });
    });
  }
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const finish = (value) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003') {
          // Ctrl-C:交还给外层,由它统一退出。
          finish('');
          process.kill(process.pid, 'SIGINT');
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}
