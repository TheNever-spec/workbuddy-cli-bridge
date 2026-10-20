/*
 * 对照实验 v3：干净环境 + 配置目录对照
 * 关键：剥掉 shell 里继承的 CODEBUDDY_* 变量，避免污染
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const CLAUDIAN_CFG = path.join(os.homedir(), '.claudian', 'wb-cli-config');
const WB_CFG = path.join(os.homedir(), '.workbuddy');

const ARGS = [
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
  '--replay-user-messages',
  '--add-dir', path.join(os.tmpdir(), 'claudian-sessions'),
];

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CODEBUDDY_')) continue;
    if (k.startsWith('WORKBUDDY_')) continue;
    if (k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return Object.assign(env, extra || {});
}

function initReq() {
  return {
    type: 'control_request',
    request_id: 'req_init_1',
    request: {
      subtype: 'initialize',
      hooks: {},
      sdkMcpServers: [],
      jsonSchema: {},
      agents: {},
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: '',
      systemPrompt: ['You are a helpful assistant operating inside Obsidian.'],
    },
  };
}
function userMsg() {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] },
  };
}

function runCase(name, extraEnv, extraArgs, waitMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...ARGS, ...(extraArgs || [])], {
      cwd: CWD,
      env: cleanEnv(extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const seq = [];
    let sawResult = false;
    let resultText = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let t = 'NOTJSON';
        try {
          const o = JSON.parse(line);
          t = o.type || '?';
          if (o.type === 'result') {
            sawResult = true;
            resultText = String(o.result || '').slice(0, 60);
          }
        } catch (_e) {}
        if (t !== 'stream_event') seq.push(t);
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-400);
    });
    setTimeout(() => child.stdin.write(JSON.stringify(initReq()) + '\n'), 200);
    setTimeout(() => child.stdin.write(JSON.stringify(userMsg()) + '\n'), waitMs || 4000);
    const timer = setTimeout(() => done('超时'), 30000);
    const poll = setInterval(() => {
      if (sawResult) {
        clearInterval(poll);
        clearTimeout(timer);
        done('拿到 result');
      }
    }, 300);
    function done(why) {
      clearInterval(poll);
      clearTimeout(timer);
      try { child.kill(); } catch (_e) {}
      resolve({ name, sawResult, why, seq: seq.join('>').slice(0, 400), resultText, err: errTail.replace(/\s+/g, ' ').slice(0, 250) });
    }
  });
}

(async () => {
  const cases = [
    ['1 干净env + CFG=claudian/wb-cli-config', { CODEBUDDY_CONFIG_DIR: CLAUDIAN_CFG }, [], 4000],
    ['2 干净env + CFG=~/.workbuddy', { CODEBUDDY_CONFIG_DIR: WB_CFG }, [], 4000],
    ['3 干净env + CFG=claudian + 延时15s', { CODEBUDDY_CONFIG_DIR: CLAUDIAN_CFG }, [], 15000],
  ];
  for (const c of cases) {
    const r = await runCase(...c);
    console.log(`\n#### ${r.name}\n  result=${r.sawResult} (${r.why}) 文本=${JSON.stringify(r.resultText)}\n  事件=${r.seq}\n  stderr=${r.err || '无'}`);
  }
  process.exit(0);
})();
