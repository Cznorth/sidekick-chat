#!/usr/bin/env node
/**
 * `npx sidekick-chat` / `npm i -g sidekick-chat` 之后的入口。
 *
 * 启动时先看有没有已经下好的新版(在 ~/.sidekick/cli/<版本>/):有就直接跑它,
 * 下一次启动就生效。没有的话顺手拉起后台进程去 npm registry 查一次,不挡前台。
 */
import { pathToFileURL } from 'node:url';

async function main() {
  const argv = process.argv.slice(2);
  const delegated = process.env.SIDEKICK_UPDATE_DELEGATED === '1';
  const disabled = process.env.SIDEKICK_NO_UPDATE === '1' || argv.includes('--no-update');
  const skipCheck = argv.some((arg) => ['--version', '-v', '--help', '-h'].includes(arg))
    || ['help', 'update'].includes(argv[0]);

  let update = null;
  try {
    update = await import('../src/update.mjs');
  } catch {
    /* 更新模块本身坏了也别挡住正常使用 */
  }

  if (update && !disabled) {
    if (!delegated) {
      const newer = update.newerCachedVersion();
      if (newer) {
        process.env.SIDEKICK_UPDATE_DELEGATED = '1';
        update.logUpdate(`改用已下载的 ${newer.version}`);
        try {
          await import(pathToFileURL(newer.bin).href);
          return;
        } catch (err) {
          update.logUpdate(`运行 ${newer.version} 失败,继续用当前版本:${err instanceof Error ? err.message : String(err)}`);
          delete process.env.SIDEKICK_UPDATE_DELEGATED;
        }
      }
    }
    // 已经在跑下载好的新版时也要继续查,否则有了第一份缓存之后就再也不升级了。
    if (!skipCheck && update.needsCheck()) update.spawnUpdateWorker();
  }

  // 0.3.0 的更新器下出来的新版没有 node_modules,第一次启动时补上。
  if (update) update.ensureOwnDependencies();

  const { run } = await import('../src/main.mjs');
  await run(argv);
}

await main();
