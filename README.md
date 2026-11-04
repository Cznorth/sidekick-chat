# Sidekick 终端客户端

在终端里和秘书说话。它只是 `chat` World 的又一个客户端,和手机 App、网页版共用同一批会话、未读和回复,
不新增任何后端接口——所以手机上收到的、终端里发的,是同一份对话。

```
$ npx sidekick-chat
Sidekick · 秘书 https://hkv4.cznorth.cn/chat
会话:秘书 · /help 看命令,/conv 列会话,Ctrl-C 退出
────────────────────────────
[11-03 13:39] 秘书 codex/gpt-5.5
  已经把 frp 备用入口补给执行器了。
你 › 明天几点提醒我看牙
[13:44] 我
  明天几点提醒我看牙
[13:44] 秘书 codex/gpt-5.5
  记成明天 9:30,提前 10 分钟提醒。
```

0.2.6 起，当前会话各 bot 的最后 LLM 调用时间和对应活动常驻显示在输入框上方，并实时更新；`/who` 查看全部 bot，`/conv` 也列出成员活动。纯文本交互在启动、切换会话及活动变化时输出。时间为调用开始时间，忙闲、消息和心跳不刷新它；没有记录时显示「尚无 LLM 活动记录」。

## 安装

```bash
npx sidekick-chat          # 不装直接用
npm i -g sidekick-chat     # 或者装到全局,命令就是 sidekick
```

仓库里直接用(还没发包时):

```bash
node cli/bin/sidekick.mjs
```

0.2.3 起，输入 `/usage` 时才查询并显示 OpenCode、Codex、Claude WSL 和 Claude Docker 的剩余额度、采样及重置时间。没有常驻 HUD，也不在后台自动刷新。`/quota` 是兼容别名，纯文本交互也支持。刷新失败保留上次查询值并标注，无数据时显示未知。额度沿用 App 的接口，不需要在 CLI 配置模型 API key。

0.2.1 起，交互界面实时显示服务器的流式回复草稿，支持生成中的 Markdown；正式消息到达后替换草稿，不重复显示。切换会话、断线、清屏或服务端撤回会清除临时草稿。草稿不落盘，重连只补正式消息。`--plain`、管道、一次性 `ask` 和 `--json` 只输出正式消息。

需要 Node 22.19 以上。交互界面使用与 Pi agent 相同的 `@earendil-works/pi-tui`，支持 Markdown、中文换行、多行粘贴、输入历史和窗口缩放。

Enter 发送，Shift+Enter 换行（终端需支持；也可用 Ctrl+J），↑/↓ 翻输入历史。回复和忙碌状态更新时保留输入草稿与光标。

复制图片后按 **Ctrl+V** 或输入 **`/paste`**，图片会进入待发送区；可继续输入说明，按 Enter 一起发送。终端如果拦截 Ctrl+V（复制图片时通常不会向程序发出字符），请用 `/paste`。文字仍可用终端的 Ctrl+Shift+V / 右键粘贴。也可以 `/image "D:\图片\截图.png"` 添加文件。每条最多 4 张、每张 6 MB，支持 PNG/JPEG/GIF/WebP；`/drop` 清除待发送图片，`/send [说明]` 发送（纯文本模式用这个命令）。发送失败保留图片，切换会话前须发送或清除。

Windows 使用系统剪贴板，无需另装工具；macOS 需安装 `pngpaste`，Linux 使用 `wl-clipboard`（Wayland）或 `xclip`（X11）。剪贴板读取发生在运行 CLI 的机器上，SSH 会话可改用 `/image` 读取远端文件。

老终端可用 `sidekick --plain`：不上色、不重画输入行。管道和 `TERM=dumb` 自动使用纯文本；`--no-color` / `NO_COLOR` 只关闭颜色。一次性 `ask` 和 `--json` 保持文本/JSON 输出。

## 登录

凭据存在 `~/.sidekick/config.json`(权限 600),两种方式任选:

```bash
sidekick login                                  # 问地址和网页密码,换一个登录 Cookie
sidekick login --url http://47.96.64.66:18792 --token <设备令牌>   # 直连 chat World
```

- **网页密码**:就是网页版那个 `CORTICO_WEB_PASSWORD`。客户端拿它调站点的 `/api/auth/login`,
  拿到 `cortico_session` Cookie 存起来,400 天不用重登。服务器地址默认 `https://hkv4.cznorth.cn/chat`。
- **设备令牌**:部署 `.env` 里的 `SIDEKICK_DEVICE_TOKEN`,和手机 App 用的是同一个。
  适合备用线路(杭州 `47.96.64.66:18792`)这种没有网页登录接口的直连地址。

`sidekick logout` 清掉本机登录态。Cookie 失效时会提示重新 `sidekick login`。

## 用法

```bash
sidekick                          # 进交互,一行一句
sidekick "今天有什么安排"          # 问一句,回复打印完就退出(适合脚本/管道)
sidekick ask --wait 20 "…"        # 同上,收到第一条后最多再等 20 秒后续消息
sidekick --conv 收发室             # 指定会话:名字、id 或 /conv 里的序号
sidekick --json "…"               # 每条消息输出一行 JSON
sidekick --device 家里的电脑 "…"   # 换一个署名(默认「终端」)
```

交互里的命令:

| 命令 | 作用 |
|---|---|
| `/conv` | 列出会话(带未读和最后一条摘要) |
| `/to <序号\|名字>` | 切换会话 |
| `/history [n]` | 重印最近 n 条,默认 20 |
| `/who` | 名册:谁在线、谁在忙 |
| `/usage` | 查询额度，查看剩余比例、采样和重置时间（`/quota` 为兼容别名） |
| `/clear` | 清屏 |
| `/quit` | 退出(也可以 Ctrl-C) |

其它会话来消息时只在终端里提一句,`/to` 切过去看。其它设备上聊的、手机上聊的,这里都能看到历史的最近 30 条。

**已读只在“人在终端前面”的时候推进**:没过按键的终端收到新消息只把进度攒着,等你下次敲键、发消息或切会话才一起报成已读。
这样调下来的碎片(或被遗忘的)终端窗口不会把手机上刚弹出的通知瞬间顶掉——已读是多端同步的,任一客户端一推,其他设备就撤通知。

## 环境变量

参数优先于环境变量,环境变量优先于配置文件:

| 变量 | 作用 |
|---|---|
| `SIDEKICK_URL` | 服务器地址,如 `https://hkv4.cznorth.cn/chat` |
| `SIDEKICK_TOKEN` | 设备令牌(Bearer) |
| `SIDEKICK_PASSWORD` | 网页登录密码(只在 `sidekick login` 时用,不落盘) |
| `SIDEKICK_COOKIE` | 直接给 `cortico_session` 的值 |
| `SIDEKICK_DEVICE` | 这台机器的署名 |
| `SIDEKICK_CONFIG` | 配置文件路径,默认 `~/.sidekick/config.json` |
| `NO_COLOR` | 设了就不上色 |

## 怎么实现的

只用了 `chat` World 已经开给手机 App 和网页的那几个接口(`packages/world-chat/src/world.ts` 的 `startHub`):

| 接口 | 用途 |
|---|---|
| `GET /v1/team/state` | 主 Bot、名册、会话列表 |
| `GET /v1/team/history?conv=&limit=` | 一个会话的历史 |
| `POST /v1/team/send` | 发一句 |
| `POST /v1/team/read` | 标记已读 |
| `GET /v1/team/stream?after=` | SSE 推流:消息、正在输入、连接状态 |

```
bin/sidekick.mjs   入口,把参数交给 src/main.mjs
src/main.mjs       login / logout / ask / 交互三种流程
src/api.mjs        接口调用与 SSE 解析,断线按 1s→30s 退避重连,重连时带 seq 补收
src/config.mjs     ~/.sidekick/config.json 读写,参数 > 环境变量 > 配置文件的优先级
src/format.mjs     纯文本消息排版(纯函数)
src/tui.mjs        Pi TUI：Markdown、编辑器、忙碌状态和差分渲染
src/prompt.mjs     提问与遮掉回显的密码输入
test/              node:test,`npm test`;有一个假 World 顶替服务器,不需要联网
```

## 测试

```bash
cd cli && node --test
```

`test/fake-world.mjs` 起了个假的 chat World(实现上面五个接口),所以鉴权失败、发送、推流补收、
`sidekick ask` 端到端这些都能脱网验证。
