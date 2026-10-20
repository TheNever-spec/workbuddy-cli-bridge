# workbuddy-cli-bridge

让 [Obsidian](https://obsidian.md) 的 **Claudian** 插件（基于 `@anthropic-ai/claude-agent-sdk`）调用 **WorkBuddy 桌面版自带的 CLI**，从而复用本机的 WorkBuddy 账号和模型额度。

> 只能在 Windows 上跑，且本机需要装有 WorkBuddy 桌面版。所有逻辑都在本地，不代理任何外部流量。

---

## 它解决什么

WorkBuddy CLI 和 Claude Code CLI 的命令行协议大体同源，但细节上有一堆对不上的地方。直接指过去，现象分别是：

| 现象 | 真实原因 | 桥接层怎么处理 |
| --- | --- | --- |
| `Claude Code process exited with code 1` | SDK 下发 Claude Code 专有参数（`--thinking`、`--betas`、`--project-config-root` 等），CLI 报 `unknown option` | 静态黑名单 + 动态探测 `--help` 里的参数表，凡是不支持的一律摘掉 |
| 助手回复变成 `src must be a string or an object describing the source` | SDK 把 `systemPrompt` 下发成数组，CLI 交给 Nunjucks `renderString()`，而 Nunjucks 判定数组不是 object | 改写 stdin，把 `systemPrompt` / `appendSystemPrompt` 数组拼成字符串 |
| `Authentication required` | 新版桌面版把凭据做了 AES-GCM 加密，解密密钥只发给它自己的子进程 | 抓一份明文令牌存到 `wb-token.json`，逐次续期并注入 `CODEBUDDY_AUTH_TOKEN` |
| 续接旧会话时界面永远转圈 | `--resume=<id>` 指向的 jsonl 已不存在，CLI 既不报错也不退出 | 启动前核对会话文件，不存在就摘掉 `--resume` 开新会话 |
| 模型选择器显示 `Model unavailable` | CLI 回包里的模型是 `{id, name}`，SDK 约定的是 `{value, displayName, description}` | 输出侧逐行重写 `control_response`，补齐字段名 |
| **发消息后界面无限转圈** | CLI 要在本机起 HTTP 端点，端口被残留进程占住时只记一条 `EADDRINUSE` 的 unhandledRejection，端点永不 ready | 启动前自己挑一个「bind 得通 + 没人应答」的端口写进 `SERVER__PORT` |

最后一条是最隐蔽的：进程活着、日志不多、CPU 几乎为零，换新会话照样卡。详见 [`repro/repro-07-decisive.cjs`](repro/repro-07-decisive.cjs)。

---

## 安装

1. 把本目录下的 `workbuddy-cli.cjs`、`wb-login.cjs`、`wb-token-refresh.cjs`、`wb-capture-hook.cjs` 复制到：

   ```
   %USERPROFILE%\.claudian\
   ```

2. 跑一次登录，按提示在浏览器里授权：

   ```bash
   node %USERPROFILE%\.claudian\wb-login.cjs
   ```

   成功后会用明文令牌写出 `%USERPROFILE%\.claudian\wb-token.json`（权限 0600）。

3. 打开 Obsidian → 设置 → Claudian → **Claude CLI 路径**，指向：

   ```
   %USERPROFILE%\.claudian\workbuddy-cli.cjs
   ```

4. 新开一个对话，模型选择器里应该能看到 18 个可用模型。

令牌有效期约 28 天，`wb-token-refresh.cjs` 会在每次桥接启动时自动检查并续期（剩余不足 1 小时才真正发请求）。续不动了才需要重跑第 2 步。

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `workbuddy-cli.cjs` | 桥接主体。定位 CLI 入口、认证引导、参数清洗、stdin/stdout 改写、端口兜底，最后同进程 `require` CLI |
| `wb-login.cjs` | 一键登录。起一个本地 CLI 服务，打印授权链接，抓到令牌后自动落盘并退出 |
| `wb-token-refresh.cjs` | 令牌保活。快过期时用 refreshToken 换新的；`--status` 看剩余时间，`--print` 输出当前令牌 |
| `wb-capture-hook.cjs` | 抓取层。patch `http/https.request` 与 `fetch`，从认证响应里截出明文令牌 |
| `repro/` | 排查过程中写的复现脚本，见下 |

### CLI 入口定位

默认按以下顺序找 `bin/codebuddy`：

1. `E:\WorkBuddy\resources\app.asar.unpacked\cli`
2. `C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli`
3. `%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli`
4. `$WORKBUDDY_RESOURCES_PATH\app.asar.unpacked\cli`

装在别处的，改 `workbuddy-cli.cjs` 里的 `CANDIDATES` 数组，或者设 `WORKBUDDY_RESOURCES_PATH`。

---

## 排查

日志固定在：

```
%USERPROFILE%\.claudian\bridge.log        # 桥接层常态日志
%USERPROFILE%\.claudian\token-refresh.log # 令牌续期记录
%USERPROFILE%\.claudian\wb-cli-config\logs\<日期>\*.log  # CLI 自己的日志
```

常态只记启动参数、认证状态、退出码、stderr 摘要，体积很小。要看完整的 stdio 协议镜像，开调试模式：

```bash
set WORKBUDDY_BRIDGE_DEBUG=1
```

或者在 `%USERPROFILE%\.claudian\` 下建一个空文件 `bridge-debug.flag`。

相关开关：

| 环境变量 | 作用 |
| --- | --- |
| `WORKBUDDY_BRIDGE_DEBUG=1` | 打开 stdin/stdout 协议镜像 |
| `WORKBUDDY_BRIDGE_NO_PORT_FIX=1` | 关闭端口兜底（只用于对照排查） |
| `WORKBUDDY_TOKEN_REFRESH_THRESHOLD` | 提前多少秒续期，默认 3600 |
| `WORKBUDDY_RESOURCES_PATH` | 手动指定 WorkBuddy 资源目录 |

---

## 复现脚本

`repro/` 下是定位「发消息一直卡着」时逐个排除问题的脚本，都按 Claude Agent SDK 的线协议手搓（换行分隔的 JSON），可以直接跑：

| 脚本 | 用途 |
| --- | --- |
| `repro-02-streamjson.cjs` | 最小协议复刻。发一条用户消息，看 CLI 到底吐不吐 `result` |
| `repro-03-variants.cjs` | 逐个去掉参数变量（systemPrompt、`--replay-user-messages`、`--tools` 等）做对照 |
| `repro-04-cfg.cjs` | 对比不同 `CODEBUDDY_CONFIG_DIR` 下的表现 |
| `repro-05-full.cjs` | 完整捕获 stdout/stderr，定位栈信息 |
| `repro-06-fix.cjs` | 端口兜底的分组验证 |
| `repro-07-decisive.cjs` | **决定性对照**。占住一个端口当作继承来的 `SERVER__PORT`：关掉兜底会复现卡死，打开兜底正常拿到 result |

跑之前把 `WB_BRIDGE`（桥接脚本路径）和 `WB_CWD`（工作目录，默认 `~/Documents/Obsidian Vault`）按需覆盖。

注意：这些脚本会主动剔除父进程里的 `CODEBUDDY_*`、`WORKBUDDY_*`、`SERVER__*`、代理类环境变量。如果你在 WorkBuddy 自己的终端里跑，不剔除会被污染，结论会失真。

---

## 已知限制

- 只测过 Windows + WorkBuddy 桌面版 R2025a 这一套，macOS / Linux 的 CLI 目录布局不同，需要自己改 `CANDIDATES`。
- 依赖 CLI 内部的 `SERVER__PORT`、`CODEBUDDY_FORCE_LITE_WB_BUNDLE`、`CODEBUDDY_CONFIG_DIR` 这些环境变量名。WorkBuddy 升级若改了内部实现，桥接层可能失效——`bridge.log` 会指出断在哪一步。
- 模型字段名适配是「只加别名、不改结构」，如果哪天 CLI 同时返回新旧两套字段，会因为已有 `value` 而跳过重写。
- 动态参数探测读的是 CLI 的 `--help`。若 CLI 把某个参数藏起来不在 help 里列，会被误摘，需要加回 `UNSUPPORTED_*` 的例外。

---

## 免责声明

本项目是**本机客户端互操作**的实践记录：所有操作的发起者、账号和额度都属于使用者自己，不涉及任何服务端绕过，也不代理他人流量。

但它确实包含「从内存里截取明文令牌」「绕开桌面版凭据加密」这类手法。**请只在自己的机器、自己的账号上使用。** 公开分发或用于他人账号可能违反 WorkBuddy 的服务条款，作者不承担由此产生的任何责任。

---

## License

MIT
