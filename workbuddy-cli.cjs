/*
 * workbuddy-cli.cjs —— WorkBuddy CLI 桥接层（生产版）
 * ===============================================================
 * 作用：让 Obsidian 的 Claudian（走 @anthropic-ai/claude-agent-sdk）
 *       使用 WorkBuddy 桌面版自带的 CLI 干活，复用其账号与模型额度。
 *
 * 本文件只做两件必须的事，其余全部原样透传：
 *
 *   A. 参数清洗
 *      claude-agent-sdk 会下发一批 Claude Code 专有参数，WorkBuddy CLI
 *      不认识就会 `error: unknown option` 并以退出码 1 结束，表现为
 *      Claudian 报 "Claude Code process exited with code 1"。
 *
 *   B. stdin 改写（systemPrompt 数组 → 字符串）
 *      SDK 在 initialize 控制请求里把 systemPrompt 下发成数组，而 CLI
 *      会把它当模板源交给 Nunjucks renderString()；Nunjucks 的 isObject
 *      判定排除数组，于是抛
 *        "src must be a string or an object describing the source"
 *      并把它当成助手回复返回。此时模型根本没被调用（input_tokens=0）。
 *
 *   C. 认证引导
 *      新版桌面版把凭据文件里的令牌做了 AES-GCM 加密，解密密钥只发给它
 *      自己的子进程；从外部启动的 CLI 读不到，报 Authentication required。
 *      绕法：本文件在启动 CLI 前先跑一次 wb-token-refresh.cjs 保活令牌，
 *      再把明文 accessToken 注入 CODEBUDDY_AUTH_TOKEN 环境变量，并补齐
 *      运行新版 CLI 必需的环境变量（产物开关 / 主机名 / 配置目录）。
 *
 * 使用：Claudian 设置里把 Claude CLI 路径指向本文件。
 *
 *   D. 断链会话保护
 *      Claudian 会用 `--resume=<sessionId>` 续接历史会话。若那条会话的
 *      jsonl 已不存在（换过配置目录、被清理、换过工作目录），CLI 不报错，
 *      而是静默什么都不做——不回 result 也不退出，界面永远转圈。
 *      本文件会先核对会话文件，不存在就摘掉 --resume，改为开新会话。
 *
 *   E. 模型清单字段名适配
 *      Claudian 靠「跑一次 CLI 读 initialize 回包」来发现可用模型。
 *      WorkBuddy CLI 回包里的模型是 {id, name}，而 claude-agent-sdk 约定的是
 *      {value, displayName, description}。字段名对不上 → 插件把整份清单当无效
 *      丢弃 → 模型列表为空 → 模型选择器显示 "Model unavailable"。
 *      本文件在输出侧把字段名补齐（只加别名，不改结构），其余原样透传。
 *
 * 排查问题：常态日志（启动参数 / 认证状态 / 退出码 / stderr 摘要）始终写入
 *   %USERPROFILE%\.claudian\bridge.log
 * 需要看 stdin / stdout 协议镜像时，再开调试模式：
 *   环境变量 WORKBUDDY_BRIDGE_DEBUG=1，
 *   或在 %USERPROFILE%\.claudian\ 下建一个空文件 bridge-debug.flag
 *
 *   F. 本机端点端口兜底
 *      CLI 启动时要在本机起一个 HTTP 端点（读 SERVER__PORT）。没给端口时它会去读
 *      <配置目录>/web-ui-port.json 里持久化的端口清单并复用旧端口；若端口已被
 *      别的残留进程占用，CLI 只记一条 EADDRINUSE 的 unhandledRejection，端点却
 *      永远不 ready。表现就是「发消息后界面无限转圈」，且换新会话依然卡。
 *      本文件启动前自己挑一个「bind 得通 + 没人应答」的端口写进 SERVER__PORT，
 *      直接跳过那份清单；继承来的 SERVER__PORT 若已被占用也会被替换。
 *      对应的排查开关：WORKBUDDY_BRIDGE_NO_PORT_FIX=1 可关闭该兜底做对照。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// 日志分两档：
//   log()  —— 常态，始终记录（启动参数 / 认证状态 / 退出码 / stderr 摘要），体积很小
//   logV() —— 详细，仅调试模式（stdin / stdout 协议镜像），只在排查时开
const LOG_DIR = path.join(os.homedir(), '.claudian');
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');
const DEBUG =
  String(process.env.WORKBUDDY_BRIDGE_DEBUG || '') === '1' ||
  fs.existsSync(path.join(LOG_DIR, 'bridge-debug.flag'));

function writeLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_e) {
    /* 日志失败不影响主流程 */
  }
}
function log(msg) {
  writeLog(msg);
}
function logV(msg) {
  if (DEBUG) writeLog(msg);
}

// ===== 1. 定位 WorkBuddy CLI 入口 =====
const CANDIDATES = [
  'E:\\WorkBuddy\\resources\\app.asar.unpacked\\cli',
  'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli'),
  process.env.WORKBUDDY_RESOURCES_PATH
    ? path.join(process.env.WORKBUDDY_RESOURCES_PATH, 'app.asar.unpacked', 'cli')
    : null,
].filter(Boolean);

let entry = null;
for (const dir of CANDIDATES) {
  const p = path.join(dir, 'bin', 'codebuddy');
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      entry = p;
      break;
    }
  } catch (_e) {
    /* 忽略单个候选探测失败 */
  }
}

log('================ 桥接启动 ================');
log(`pid=${process.pid} cwd=${process.cwd()}`);

if (!entry) {
  const msg =
    '[workbuddy-cli] 找不到 WorkBuddy CLI。已尝试：\n  ' +
    CANDIDATES.join('\n  ') +
    '\n请修改 ' + __filename + ' 的 CANDIDATES 数组。';
  log(msg);
  console.error(msg);
  process.exit(1);
}
log(`entry=${entry}`);

// ===== 1.B 认证引导 =====
// 桌面版新版把凭据加密，外部进程读不到 → 改用「明文令牌 + 环境变量注入」：
//   1) 跑一次令牌保活脚本（令牌快过期才真正发网络请求，否则本地秒退）
//   2) 从 wb-token.json 读 accessToken，注入 CODEBUDDY_AUTH_TOKEN
//   3) 补齐运行新版 CLI 必需的环境变量（产物开关 / 主机名 / 配置目录）
const CLAUDIAN_DIR = path.join(os.homedir(), '.claudian');
const TOKEN_FILE = path.join(CLAUDIAN_DIR, 'wb-token.json');
const REFRESH_SCRIPT = path.join(CLAUDIAN_DIR, 'wb-token-refresh.cjs');

function bootstrapAuth() {
  // 1) 令牌保活（失败不阻断：旧令牌可能仍然有效）
  if (fs.existsSync(REFRESH_SCRIPT)) {
    try {
      const r = spawnSync(process.execPath, [REFRESH_SCRIPT], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 40000,
      });
      log(`令牌保活脚本退出码=${r && r.status}`);
    } catch (e) {
      log('令牌保活脚本调用失败: ' + String(e));
    }
  } else {
    log('未找到令牌保活脚本，跳过: ' + REFRESH_SCRIPT);
  }

  // 2) 注入明文令牌
  let token = null;
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    token = d && d.accessToken ? d.accessToken : null;
  } catch (_e) {
    /* 无令牌文件或解析失败 */
  }
  if (token) {
    process.env.CODEBUDDY_AUTH_TOKEN = token;
    log('已注入 CODEBUDDY_AUTH_TOKEN（来自 wb-token.json）');
  } else if (process.env.CODEBUDDY_AUTH_TOKEN) {
    log('wb-token.json 缺失或无效，沿用外部 CODEBUDDY_AUTH_TOKEN');
  } else {
    log('警告：没有可用令牌，CLI 很可能报 Authentication required');
  }

  // 3) 新版 CLI 必需的环境变量（外部已设则不覆盖）
  if (!process.env.CODEBUDDY_HOST) process.env.CODEBUDDY_HOST = 'workbuddy-desktop';
  if (!process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE) {
    process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
  }
  if (!process.env.CODEBUDDY_CONFIG_DIR) {
    process.env.CODEBUDDY_CONFIG_DIR = path.join(CLAUDIAN_DIR, 'wb-cli-config');
  }
  log(
    `环境: HOST=${process.env.CODEBUDDY_HOST} ` +
      `LITE=${process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE} ` +
      `CFG=${process.env.CODEBUDDY_CONFIG_DIR}`
  );
}

bootstrapAuth();

// ===== 2.A 参数清洗 =====
// 名单 = claude-agent-sdk 全部会 push 的参数 与 `codebuddy --help` 支持的参数 求差集
const UNSUPPORTED_WITH_VALUE = new Set([
  '--debug-file', // 调试模式下会转译成 CLI 支持的 --debug
  '--thinking',
  '--thinking-display',
  '--max-thinking-tokens',
  '--max-budget-usd',
  '--task-budget',
  '--betas',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--managed-settings',
  '--resume-session-at',
  '--resume-drops-turn',
  '--project-config-root',
]);

const UNSUPPORTED_FLAG_ONLY = new Set([
  '--allow-dangerously-skip-permissions',
  '--await-initialize',
  '--include-hook-events',
  '--session-mirror',
]);

// ===== 2.A-0 动态参数表 =====
// 起因：Claudian 2.3.x 开始下发 `--project-config-root=<path>` 这类新参数，
// WorkBuddy CLI 不认识就 `error: unknown option` 并以退出码 1 结束，表现为
// Claudian 一直重试、界面卡住。静态黑名单只能治标，所以这里再补一道：
// 探测 CLI 自己 `--help` 里声明的参数，凡是不在其中的长参数一律剔除。
// 结果按 CLI 文件 mtime 缓存；探测失败则退回静态黑名单，不影响主流程。
const SUPPORTED_CACHE = path.join(CLAUDIAN_DIR, 'cli-options.json');

function parseHelpOptions(text) {
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    // commander 的格式：缩进后是「参数」，两空格以上之后才是说明文字
    if (!/^\s{2,}-/.test(line)) continue;
    // 行首就是两个空格，split 出来的第一段会是空串，必须先滤掉
    const flags = line.split(/\s{2,}/).filter(Boolean)[0] || '';
    if (!flags.startsWith('-')) continue;
    const re = /--([A-Za-z][A-Za-z0-9-]*)\s*([<\[])?/g;
    let m;
    while ((m = re.exec(flags))) map[m[1]] = !!m[2];
  }
  return map;
}

function loadSupportedOptions() {
  let mtime = 0;
  try {
    mtime = fs.statSync(entry).mtimeMs;
  } catch (_e) {
    /* 忽略 */
  }
  try {
    const c = JSON.parse(fs.readFileSync(SUPPORTED_CACHE, 'utf8'));
    if (c && c.mtime === mtime && c.options && Object.keys(c.options).length > 30) {
      return c.options;
    }
  } catch (_e) {
    /* 无缓存 */
  }
  try {
    const r = spawnSync(process.execPath, [entry, '--help'], {
      env: process.env,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const opts = parseHelpOptions((r.stdout || '') + (r.stderr || ''));
    if (Object.keys(opts).length > 30) {
      try {
        fs.writeFileSync(SUPPORTED_CACHE, JSON.stringify({ mtime, options: opts }));
      } catch (_e) {
        /* 缓存写不了不影响本次 */
      }
      log(`动态探测到 ${Object.keys(opts).length} 个 CLI 支持的参数`);
      return opts;
    }
    log('--help 解析结果过少，本次跳过动态校验');
  } catch (e) {
    log('动态探测参数表失败: ' + String(e));
  }
  return null;
}

const supportedOptions = loadSupportedOptions();

const rawArgs = process.argv.slice(2);
const keptArgs = [];
const stripped = [];
let wantDebug = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  const eq = arg.indexOf('=');
  const flagName = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;

  if (UNSUPPORTED_FLAG_ONLY.has(flagName)) {
    stripped.push(arg);
    continue;
  }

  if (UNSUPPORTED_WITH_VALUE.has(flagName)) {
    if (flagName === '--debug-file') {
      // 仅调试模式下转译成 --debug；生产环境直接丢弃，避免 debug 日志级别拖慢 CLI
      if (DEBUG) wantDebug = true;
      stripped.push(arg);
      const next = rawArgs[i + 1];
      if (!arg.includes('=') && next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    if (arg.includes('=')) {
      stripped.push(arg);
    } else {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        stripped.push(`${arg} ${next}`);
        i++;
      } else {
        stripped.push(arg);
      }
    }
    continue;
  }

  // 动态校验：CLI `--help` 里没有声明的长参数一律剔除（防止插件升级再次触发 unknown option）
  if (supportedOptions && arg.startsWith('--') && !(flagName.slice(2) in supportedOptions)) {
    stripped.push(arg);
    if (!arg.includes('=')) {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
    }
    continue;
  }

  keptArgs.push(arg);
}

if (wantDebug) keptArgs.push('--debug');
if (stripped.length) log(`已摘除不支持的参数: ${JSON.stringify(stripped)}`);

// ===== 2.A-2 断链会话保护 =====
// Claudian 续接历史会话时下发 `--resume=<sessionId>`。若那条会话的 jsonl 不在
// 本机（换过配置目录、被 30 天清理、或换了工作目录），CLI 既不报错也不干活：
// 不回 result、不退出，界面就一直转圈。这里先核对文件，不存在就摘掉 --resume。
const RESUME_CONFIG_DIR =
  process.env.CODEBUDDY_CONFIG_DIR || path.join(CLAUDIAN_DIR, 'wb-cli-config');

function projectSlug(cwd) {
  let s = String(cwd).replace(/\\/g, '/');
  s = s.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + '-');
  return s.replace(/\//g, '-');
}

function sessionFileExists(id) {
  try {
    const p = path.join(RESUME_CONFIG_DIR, 'projects', projectSlug(process.cwd()), `${id}.jsonl`);
    return fs.existsSync(p);
  } catch (_e) {
    return true; // 判断不了就不干预
  }
}

for (let i = keptArgs.length - 1; i >= 0; i--) {
  const a = keptArgs[i];
  let id = null;
  let inline = false;
  if (a.startsWith('--resume=')) {
    id = a.slice('--resume='.length);
    inline = true;
  } else if (a === '--resume') {
    const nx = keptArgs[i + 1];
    if (nx !== undefined && !nx.startsWith('-')) id = nx;
  }
  if (!id) continue;
  if (sessionFileExists(id)) continue;
  if (inline) keptArgs.splice(i, 1);
  else keptArgs.splice(i, 2);
  log(`会话 ${id} 在本机已不存在，摘除 --resume，改为开新会话`);
}

// bin/codebuddy 在模块加载时就读 process.argv.slice(2)，必须先改写
process.argv = [process.argv[0], entry, ...keptArgs];
log(`启动 pid=${process.pid} cwd=${process.cwd()}`);
log(`原始参数 = ${JSON.stringify(rawArgs)}`);
log(`清洗后 argv = ${JSON.stringify(keptArgs)}`);

// ===== 2.B stdin 改写层 =====
// 必须在 require(CLI 入口) 之前注入：CLI 会绑定当时的 process.stdin
const { PassThrough } = require('stream');

function fixStdinLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.charAt(0) !== '{') return line;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (_e) {
    return line;
  }
  const req = obj && obj.request;
  if (!obj || obj.type !== 'control_request' || !req || req.subtype !== 'initialize') {
    return line;
  }
  let changed = false;
  for (const key of ['systemPrompt', 'appendSystemPrompt']) {
    const v = req[key];
    if (Array.isArray(v)) {
      req[key] = v
        .map((x) => (typeof x === 'string' ? x : ''))
        .filter(Boolean)
        .join('\n\n');
      changed = true;
    }
  }
  if (!changed) return line;
  logV(`STDIN[改写] initialize 的 systemPrompt 数组 → 字符串（${req.systemPrompt.length} 字符）`);
  return JSON.stringify(obj);
}

try {
  const tee = new PassThrough();
  const realStdin = process.stdin;
  let pending = '';

  realStdin.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      tee.write(fixStdinLine(line) + '\n');
    }
  });
  realStdin.on('end', () => {
    if (pending) tee.write(fixStdinLine(pending));
    tee.end();
  });
  realStdin.on('error', (err) => {
    log('真实 stdin 出错: ' + String(err));
    tee.end();
  });

  Object.defineProperty(process, 'stdin', {
    value: tee,
    configurable: true,
    writable: true,
  });

  if (DEBUG) {
    const origEmit = tee.emit.bind(tee);
    tee.emit = function (event, ...args) {
      if (event === 'data') {
        try {
          logV('STDIN> ' + String(args[0]).replace(/\s+$/, '').slice(0, 1200));
        } catch (_e) {
          /* 忽略 */
        }
      }
      return origEmit(event, ...args);
    };
  }
} catch (err) {
  // 改写层装不上也不能让整体挂掉：退回原样透传
  log('stdin 改写层安装失败，回退为原样透传: ' + String(err));
  console.error('[workbuddy-cli] stdin 改写层安装失败: ' + (err && err.message ? err.message : err));
}

// ===== 3. 输出镜像与退出记录 =====
// stderr 摘要始终抓取：CLI 的报错原因基本只出现在这里，而 Claudian 界面不显示。
// 协议镜像仅在调试模式打开，避免常态日志膨胀。
let stderrTail = '';

const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function (chunk, ...rest) {
  try {
    stderrTail = (stderrTail + String(chunk)).slice(-1000);
    if (DEBUG) logV('STDERR> ' + String(chunk).replace(/\s+$/, ''));
  } catch (_e) {
    /* 忽略 */
  }
  return origStderrWrite(chunk, ...rest);
};

process.on('exit', (code) => {
  log(
    `EXIT code=${code}` +
      (stderrTail ? ` stderr=${stderrTail.replace(/\s+/g, ' ').slice(-400)}` : '')
  );
});

process.on('uncaughtException', (err) => {
  log('未捕获异常: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});

// ===== 3.B 输出改写层：initialize 回包的模型清单适配 SDK 字段名 =====
// 只在 stream-json 模式（SDK 通道）启用。逐行缓冲，只对 control_response 生效。
const STREAM_JSON_MODE = keptArgs.indexOf('stream-json') >= 0;

let modelFixLogged = 0;

function normalizeModelsLine(line) {
  const t = line.trim();
  if (!t || t.charAt(0) !== '{') return line;
  if (t.indexOf('"control_response"') < 0 || t.indexOf('"models"') < 0) return line;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (_e) {
    return line;
  }
  const resp = obj && obj.response && obj.response.response;
  if (!resp || !Array.isArray(resp.models) || resp.models.length === 0) return line;
  let changed = false;
  resp.models = resp.models.map((m) => {
    if (!m || typeof m !== 'object') return m;
    // 已经是 SDK 形状（有 value）就不动
    if (typeof m.value === 'string' && m.value) return m;
    if (typeof m.id !== 'string' || !m.id) return m;
    changed = true;
    const name = typeof m.name === 'string' && m.name ? m.name : m.id;
    const out = {
      value: m.id,
      displayName: name,
      description: typeof m.description === 'string' && m.description ? m.description : name,
    };
    if (typeof m.resolvedModel === 'string' && m.resolvedModel) out.resolvedModel = m.resolvedModel;
    if (Array.isArray(m.supportedEffortLevels)) out.supportedEffortLevels = m.supportedEffortLevels;
    return out;
  });
  if (!changed) return line;
  if (modelFixLogged < 5) {
    modelFixLogged++;
    log(`已把 initialize 回包的模型清单适配为 SDK 字段名（${resp.models.length} 个模型）`);
  }
  return JSON.stringify(obj);
}

let stdoutBudget = 4000;
const origStdoutWrite = process.stdout.write.bind(process.stdout);

function logStdout(chunk) {
  try {
    const s = String(chunk);
    if (s.indexOf('"type":"error"') >= 0) {
      // 错误事件常驻记录：这是 Claudian 界面不显示、但决定成败的一类输出
      log('STDOUT[error]> ' + s.replace(/\s+$/, '').slice(0, 500));
    } else if (DEBUG) {
      if (/"type":"(control_request|control_response|result|system)"/.test(s)) {
        logV('STDOUT[协议]> ' + s.replace(/\s+$/, '').slice(0, 800));
      } else if (stdoutBudget > 0) {
        const t = s.slice(0, 300);
        stdoutBudget -= t.length;
        logV('STDOUT> ' + t.replace(/\s+$/, ''));
      }
    }
  } catch (_e) {
    /* 忽略 */
  }
}

if (STREAM_JSON_MODE) {
  let outPending = '';
  process.stdout.write = function (chunk, encoding, cb) {
    let text;
    try {
      text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    } catch (_e) {
      return origStdoutWrite(chunk, encoding, cb);
    }
    logStdout(chunk);
    outPending += text;
    let out = '';
    let idx;
    while ((idx = outPending.indexOf('\n')) >= 0) {
      const line = outPending.slice(0, idx);
      outPending = outPending.slice(idx + 1);
      out += normalizeModelsLine(line) + '\n';
    }
    const done = typeof encoding === 'function' ? encoding : cb;
    if (out) {
      const ok = origStdoutWrite(out, typeof encoding === 'function' ? undefined : encoding);
      if (typeof done === 'function') done();
      return ok;
    }
    if (typeof done === 'function') done();
    return true;
  };
  process.on('exit', () => {
    if (!outPending) return;
    try {
      origStdoutWrite(normalizeModelsLine(outPending));
    } catch (_e) {
      /* 忽略 */
    }
  });
} else {
  process.stdout.write = function (chunk, ...rest) {
    logStdout(chunk);
    return origStdoutWrite(chunk, ...rest);
  };
}

// ===== 2.C 本机端点端口兜底（关键修复）=====
// 现象：CLI 进程启动后会在本机起一个 HTTP 端点（读 process.env.SERVER__PORT）。
// 如果调用方没给端口，它会去读 <配置目录>/web-ui-port.json 里持久化下来的
// 端口清单（最多 4 个）并复用旧端口号。一旦那个端口被别的残留进程占着，
// CLI 只把 EADDRINUSE 记成一条 unhandledRejection，端点却永远不 ready——
// 于是「第一条消息发出去就石沉大海、界面无限转圈」。
//
// 做法：启动前自己挑一个「确认空闲」的端口，用 SERVER__PORT 显式喂给它，
// 直接跳过那份会复用的清单。CLI 里这段逻辑是
//   if (opts.port) SERVER__PORT = opts.port
//   else if (SERVER__PORT === undefined) SERVER__PORT = resolveStableWebUiPort(...)
// 所以只要环境变量先设好，就不会去读那份清单。
const net = require('net');

// 双重校验：先 bind 得通，再确认「没人应答」。Windows 上 SO_REUSEADDR 语义宽松，
// 光看 bind 成功并不代表端口真的空闲（别的进程可能在听），所以补一次 connect。
function probePortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try {
        srv.close();
      } catch (_e) {
        /* 忽略 */
      }
      resolve(v);
    };
    srv.once('error', () => finish(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => {
        const c = net.connect({ port, host: '127.0.0.1' });
        c.setTimeout(400);
        c.once('connect', () => {
          c.destroy();
          finish(false); // 有人在听 → 不算空闲
        });
        c.once('timeout', () => {
          c.destroy();
          finish(true);
        });
        c.once('error', () => finish(true));
      });
    });
  });
}

async function pickEndpointPort() {
  for (let i = 0; i < 30; i++) {
    const port = await new Promise((resolve) => {
      const tmp = net.createServer();
      tmp.once('error', () => resolve(0));
      tmp.listen(0, '127.0.0.1', () => {
        const p = tmp.address() && tmp.address().port;
        tmp.close(() => resolve(p || 0));
      });
    });
    if (port && (await probePortFree(port))) return port;
  }
  return 0;
}

async function applyEndpointPortGuard() {
  if (keptArgs.indexOf('stream-json') < 0) return; // 只有 SDK 通道需要
  if (keptArgs.indexOf('--port') >= 0) return; // 调用方已显式指定，尊重它
  if (String(process.env.WORKBUDDY_BRIDGE_NO_PORT_FIX || '') === '1') {
    log('端口兜底已按开关关闭（用于对照排查）');
    return;
  }
  // 已有的 SERVER__PORT（可能从父进程继承）只在「确实空闲」时才沿用；
  // 被占用就换掉——否则 CLI 只会记一条 EADDRINUSE 然后永久挂住。
  const inherited = Number(process.env.SERVER__PORT);
  if (inherited > 0 && (await probePortFree(inherited))) {
    log(`已为 CLI 本机端点选定空闲端口 ${inherited}（沿用调用方给的值）`);
    return;
  }
  const port = await pickEndpointPort();
  if (!port) {
    log('警告：没挑到空闲端口，本次沿用 CLI 自己的端口分配');
    return;
  }
  process.env.SERVER__PORT = String(port);
  log(
    `已为 CLI 本机端点选定空闲端口 ${port}` +
      (inherited > 0 ? `（原值 ${inherited} 已被占用，已替换）` : '（绕开 web-ui-port.json 的持久化端口）')
  );
}

// ===== 4. 同进程加载 CLI =====
(async () => {
  try {
    await applyEndpointPortGuard();
  } catch (e) {
    log('端口兜底环节异常，继续启动: ' + String(e));
  }
  try {
    require(entry);
    logV('CLI 入口加载完成（进入事件循环）');
  } catch (err) {
    log('加载 CLI 入口失败: ' + (err && err.stack ? err.stack : String(err)));
    console.error('[workbuddy-cli] 加载 CLI 入口失败: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
})();
