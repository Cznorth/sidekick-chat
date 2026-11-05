const count = (n) => Math.round(n).toLocaleString('en-US');

export function formatContext(bot) {
  const c = bot?.context;
  if (!c || !Number.isFinite(c.estTokens) || c.estTokens < 0) return '上下文用量未知';
  const used = count(c.estTokens);
  if (!Number.isFinite(c.maxTokens) || c.maxTokens <= 0) return `上下文 ≈ ${used} token · 预算未知`;
  return `上下文 ≈ ${used} / ${count(c.maxTokens)} token · ${Math.round(c.estTokens / c.maxTokens * 100)}%`;
}

export function applyContext(bots, frame) {
  const bot = bots.find(b => b.id === frame?.bot);
  if (!bot || !Number.isFinite(frame.at) || frame.at <= 0 || frame.at < (bot.context?.at || 0)
    || !Number.isFinite(frame.maxTokens) || frame.maxTokens <= 0
    || (frame.estTokens !== null && (!Number.isFinite(frame.estTokens) || frame.estTokens < 0))) return false;
  bot.context = { at: frame.at, estTokens: frame.estTokens, maxTokens: frame.maxTokens };
  return true;
}
