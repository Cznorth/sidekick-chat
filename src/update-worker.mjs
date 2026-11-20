/** 后台更新进程:只做一次检查,结果写进 update.log,失败不影响前台。 */
import { checkForUpdate, logUpdate } from './update.mjs';

try {
  const result = await checkForUpdate({ force: true });
  if (result.status === 'busy') logUpdate('另一个进程正在检查更新,跳过');
  else if (result.status === 'installed') logUpdate(`更新已就绪:${result.installed}`);
} catch {
  /* checkForUpdate 已经记过日志 */
}
