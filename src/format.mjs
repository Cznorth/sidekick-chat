/**
 * 把消息排版成终端里的一行行文字。纯函数,不碰网络和终端状态,好测。
 */

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
};

/** stdout 是终端、且没设 NO_COLOR 时才上色。 */
export function colorsEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream?.isTTY);
}

export function paint(enabled, code, text) {
  return enabled ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function clockTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 消息的发送者显示名:`user` 是「我」,`system` 是「系统」,其余查名册,查不到就用 id。 */
export function senderName(message, bots = []) {
  if (message.from === 'user') return '我';
  if (message.from === 'system') return '系统';
  return bots.find((b) => b.id === message.from)?.name || message.from;
}

/**
 * 一条消息排成多行:头一行是时间、名字和模型,正文缩进两格。
 * `options.attachmentUrl` 用来生成图片和文件链接。
 */
export function formatMessage(message, { bots = [], color = false, imageUrl, attachmentUrl } = {}) {
  const who = senderName(message, bots);
  const mine = message.from === 'user';
  const model = message.model ? paint(color, 'gray', message.model) : '';
  const head = [
    paint(color, 'gray', `[${clockTime(message.ts)}]`),
    paint(color, mine ? 'green' : 'cyan', who),
    model,
  ]
    .filter(Boolean)
    .join(' ');
  const lines = [head];
  if (message.reply_to) {
    const quote = `↳ 回复 ${message.reply_to.name || message.reply_to.from}:${message.reply_to.text}`;
    lines.push(`  ${paint(color, 'gray', quote)}`);
  }
  const body = String(message.text ?? '');
  for (const line of body.split('\n')) lines.push(`  ${line}`);
  for (const line of attachmentLines(message, { imageUrl, attachmentUrl })) lines.push(`  ${paint(color, 'gray', line)}`);
  return lines.join('\n');
}

export function attachmentLines(message, { imageUrl, attachmentUrl } = {}) {
  const safe = (value) => oneLine(String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  const images = (message.images ?? []).map((name) => `[图片] ${attachmentUrl?.('image', name) || imageUrl?.(name) || safe(name)}`);
  const files = (message.files ?? []).map((file) => `[附件] ${safe(file.title || file.name)}${attachmentUrl ? ` ${attachmentUrl('file', file.name)}` : ''}`);
  return [...images, ...files];
}

/** 会话列表里的一行:序号、未读数、标题、最后一条摘要。 */
export function formatConversation(conv, index, { bots = [], current = '' } = {}) {
  const mark = conv.id === current ? '*' : ' ';
  const unread = conv.unread > 0 ? ` (${conv.unread})` : '';
  const last = conv.last ? ` — ${senderName(conv.last, bots)}:${oneLine(conv.last.text, 40)}` : '';
  return `${mark}${String(index).padStart(2)}. ${conv.title}${unread}${last}`;
}

/** 去掉换行、截断到 n 个字,给列表和引用用。 */
export function oneLine(text, n = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 一条消息的纯文本版(一次性模式打印用,便于管道)。 */
export function plainMessage(message, bots = [], options = {}) {
  return [`${senderName(message, bots)}: ${String(message.text ?? '')}`.trimEnd(), ...attachmentLines(message, options)].join('\n');
}

export { ANSI };
