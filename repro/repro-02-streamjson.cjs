/*
 * 复现：完全按 claude-agent-sdk 的 stream-json 协议驱动桥接层
 * 目的：确认 CLI 在收到 user 消息后，是否会把 result 事件吐到 stdout。
 * 输出：stdout 每一行都带相对时间戳打印；stderr 单列。
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');

// 与插件实际下发一致的参数（未清洗前的原始形态）
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--model', 'deepseek-v4.1-flash',
  '--permission-prompt-tool', 'stdio',
  '--disallowedTools', 'EnterPlanMode,ExitPlanMode,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate',
  '--tools', '',
  '--setting-sources=user,project,local',
  '--permission-mode', 'bypassPermissions',
  '--allow-dangerously-skip-permissions',
  '--include-partial-messages',
  '--add-dir', path.join(os.tmpdir(), 'claudian-sessions'),
  '--enable-auto-mode',
  '--replay-user-messages',
];

const t0 = Date.now();
function ts() {
  return String(Date.now() - t0).padStart(6, ' ') + 'ms';
}
const logFile = path.join(__dirname, 'repro-02.out.log');
fs.writeFileSync(logFile, '');
function log(...a) {
  const line = `[${ts()}] ${a.join(' ')}`;
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}

const child = spawn(process.execPath, [BRIDGE, ...args], {
  cwd: CWD,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

log('已启动 pid=' + child.pid);

let stdoutBuf = '';
let stdoutLines = 0;
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8');
  let i;
  while ((i = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    stdoutLines++;
    let tag = 'OTHER';
    try {
      const o = JSON.parse(line);
      tag = o.type || '?';
      if (o.type === 'stream_event') tag = 'stream_event:' + (o.event && o.event.type);
      if (o.type === 'assistant' && o.message && o.message.content) {
        tag += ' text=' + JSON.stringify(o.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('')).slice(0, 60);
      }
      if (o.type === 'result') tag += ' subtype=' + o.subtype;
    } catch (_e) {
      tag = 'NOT-JSON';
    }
    if (tag === 'stream_event:content_block_delta' || tag === 'stream_event:message_delta') continue;
    log('STDOUT#' + stdoutLines + ' <' + tag + '> ' + line.slice(0, 300));
  }
});

child.stderr.on('data', (d) => log('STDERR> ' + String(d).replace(/\s+$/, '').slice(0, 400)));

child.on('exit', (code, sig) => {
  log('EXIT code=' + code + ' sig=' + sig);
  log('总计 stdout 行数=' + stdoutLines);
});

// ---- 1) initialize 控制请求（复刻 SDK）----
const initReq = {
  type: 'control_request',
  request_id: 'req_init_1',
  request: {
    subtype: 'initialize',
    hooks: {},
    sdkMcpServers: [],
    jsonSchema: {},
    systemPrompt: ['You are a helpful assistant operating inside Obsidian.'],
    appendSystemPrompt: '',
    agents: {},
    permissionMode: 'bypassPermissions',
  },
};
setTimeout(() => {
  log('>> 发送 initialize');
  child.stdin.write(JSON.stringify(initReq) + '\n');
}, 300);

// ---- 2) 等 8 秒后发用户消息（复刻 SDK 在初始化完成后发 prompt）----
setTimeout(() => {
  const userMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] },
    parent_tool_use_id: null,
  };
  log('>> 发送 user 消息');
  child.stdin.write(JSON.stringify(userMsg) + '\n');
}, 8000);

// ---- 3) 90 秒后收尾 ----
setTimeout(() => {
  log('>> 超时 90s，结束观察');
  try { child.kill(); } catch (_e) {}
  process.exit(0);
}, 90000);
