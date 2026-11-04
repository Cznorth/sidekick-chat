import { dayLabel, clockTime, oneLine } from './format.mjs';

export function formatActivity(bot) {
  const at = bot?.lastActiveAt;
  if (!Number.isFinite(at) || at <= 0 || Number.isNaN(new Date(at).getTime())) return '尚无 LLM 活动记录';
  const seconds = String(new Date(at).getSeconds()).padStart(2, '0');
  return `最后活跃 ${dayLabel(at)} ${clockTime(at)}:${seconds} · ${oneLine(bot.lastActivity || 'LLM 调用', 80)}`;
}

/** 旧帧不覆盖新记录;心跳、忙闲和消息都不走这里。 */
export function applyActivity(bots, frame) {
  const bot = bots.find(b => b.id === frame?.bot);
  if (!bot || !Number.isFinite(frame.at) || frame.at <= 0 || frame.at < (bot.lastActiveAt || 0)) return false;
  bot.lastActiveAt = frame.at;
  bot.lastActivity = typeof frame.text === 'string' ? frame.text : '';
  return true;
}
