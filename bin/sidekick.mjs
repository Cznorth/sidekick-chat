#!/usr/bin/env node
/**
 * `npx sidekick-chat` / `npm i -g sidekick-chat` 之后的入口:只是把参数交给 src/main.mjs。
 */
import { run } from '../src/main.mjs';

await run(process.argv.slice(2));
