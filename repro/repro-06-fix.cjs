/*
 * 回归验证 v2
 * A：关闭端口兜底，且 64519/64520（配置目录里持久化的那两个端口）被占用
 * B：启用端口兜底，同样处境
 * C：启用端口兜底，但继承来的 SERVER__PORT 指向一个已被占用的端口
 */
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const CLAUDIAN_CFG = path.join(os.homedir(), '.claudian', 'wb-cli-config');

const ARGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--model', 'deepseek-v4.1-flash',
  '--disallowedTools', 'EnterPlanMode,ExitPlanMode,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate',
  '--tools', '',
  '--setting-sources=user,project,local',
  '--permission-mode', 'bypassPermissions',
  '--include-partial-messages',
  '--replay-user-messages',
];

function cleanEnv(extra) {
  const drop = /^(CODEBUDDY_|WORKBUDDY_|CLAUDE_|CLIENT_INFO_|SANDBOX_|BASH_FUNC_|GALILEO_|SERVER__|BAGGAGE|ACC_PRODUCT_CONFIG_PATH|PYTHONPATH|BASH_ENV|EXEPATH|GENIE_TRASH_DIR|NODE_OPTIONS)/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.test(k)) continue;
    if (/^(https?|no)_proxy$/i.test(k)) continue;
    env[k] = v;
  }
  env.CODEBUDDY_CONFIG_DIR = CLAUDIAN_CFG;
  return Object.assign(env, extra || {});
}

function occupy(ports) {
  return new Promise((resolve) => {
    const servers = [];
    let left = ports.length;
    for (const p of ports) {
      const s = net.createServer(() => {});
      s.once('error', () => {
        if (--left === 0) resolve(servers);
      });
      s.listen(p, '127.0.0.1', () => {
        if (--left === 0) resolve(servers);
      });
      servers.push(s);
    }
  });
}

function runBridge(label, extraEnv, holdMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...ARGS], {
      cwd: CWD,
      env: cleanEnv(extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const seq = [];
    let sawResult = false;
    let text = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'result') {
            sawResult = true;
            text = String(o.result || '').slice(0, 40);
          }
          if (o.type !== 'stream_event') seq.push(o.type);
        } catch (_e) {
          seq.push('NOTJSON');
        }
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-300);
    });
    setTimeout(() => child.stdin.write(JSON.stringify({
      type: 'control_request', request_id: 'req_init_1',
      request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [], jsonSchema: {}, agents: {}, permissionMode: 'bypassPermissions', appendSystemPrompt: '', systemPrompt: ['You are helpful.'] },
    }) + '\n'), 200);
    setTimeout(() => child.stdin.write(JSON.stringify({
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] },
    }) + '\n'), 4000);

    const timer = setTimeout(() => done('超时未拿到 result'), holdMs || 40000);
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
      resolve({ label, sawResult, why, text, seq: [...new Set(seq)].join('>'), err: errTail.replace(/\s+/g, ' ').slice(0, 160) });
    }
  });
}

function report(r) {
  console.log(`#### ${r.label}\n  result=${r.sawResult}  (${r.why})  文本=${JSON.stringify(r.text)}\n  事件=${r.seq}\n  stderr=${r.err || '无'}\n`);
}

(async () => {
  const stale = await occupy([64519, 64520]);
  console.log('已占用 64519 / 64520（模拟残留进程）\n');
  report(await runBridge('A 关闭端口兜底（修复前）', { WORKBUDDY_BRIDGE_NO_PORT_FIX: '1' }));
  report(await runBridge('B 启用端口兜底（修复后）', {}));
  report(await runBridge('C 修复后 + 继承的 SERVER__PORT 指向被占用端口', { SERVER__PORT: '64519' }));
  for (const s of stale) { try { s.close(); } catch (_e) {} }
  process.exit(0);
})();
