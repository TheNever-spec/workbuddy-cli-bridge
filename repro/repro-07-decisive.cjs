/*
 * 决定性对照：继承的 SERVER__PORT 指向已被占用的端口
 * A 关闭兜底 → 预期卡死（复现用户看到的现象）
 * B 启用兜底 → 预期正常拿到 result
 */
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const CFG = path.join(os.homedir(), '.claudian', 'wb-cli-config');
const BUSY_PORT = 64611;

const ARGS = [
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--model', 'deepseek-v4.1-flash',
  '--disallowedTools', 'EnterPlanMode,ExitPlanMode,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate',
  '--tools', '', '--setting-sources=user,project,local',
  '--permission-mode', 'bypassPermissions', '--include-partial-messages', '--replay-user-messages',
];

function cleanEnv(extra) {
  const drop = /^(CODEBUDDY_|WORKBUDDY_|CLAUDE_|CLIENT_INFO_|SANDBOX_|BASH_FUNC_|GALILEO_|SERVER__|BAGGAGE|ACC_PRODUCT_CONFIG_PATH|PYTHONPATH|BASH_ENV|EXEPATH|GENIE_TRASH_DIR|NODE_OPTIONS)/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.test(k) || /^(https?|no)_proxy$/i.test(k)) continue;
    env[k] = v;
  }
  env.CODEBUDDY_CONFIG_DIR = CFG;
  return Object.assign(env, extra || {});
}

function run(label, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...ARGS], { cwd: CWD, env: cleanEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let sawResult = false; let buf = ''; const seq = []; let text = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.type === 'result') { sawResult = true; text = String(o.result || '').slice(0, 30); } if (o.type !== 'stream_event') seq.push(o.type); } catch (_e) {}
      }
    });
    setTimeout(() => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req_init_1', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [], jsonSchema: {}, agents: {}, permissionMode: 'bypassPermissions', appendSystemPrompt: '', systemPrompt: ['You are helpful.'] } }) + '\n'), 200);
    setTimeout(() => child.stdin.write(JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] } }) + '\n'), 4000);
    const t = setTimeout(() => done('超时未拿到 result'), 40000);
    const p = setInterval(() => { if (sawResult) { clearInterval(p); clearTimeout(t); done('拿到 result'); } }, 300);
    function done(why) { clearInterval(p); clearTimeout(t); try { child.kill(); } catch (_e) {} resolve({ label, sawResult, why, text, seq: [...new Set(seq)].join('>') }); }
  });
}

(async () => {
  const blocker = net.createServer(() => {});
  await new Promise((r) => blocker.listen(BUSY_PORT, '127.0.0.1', r));
  console.log(`已占用端口 ${BUSY_PORT}，并把它当作继承来的 SERVER__PORT\n`);

  const a = await run('A 关闭端口兜底（修复前）', { WORKBUDDY_BRIDGE_NO_PORT_FIX: '1', SERVER__PORT: String(BUSY_PORT) });
  console.log(`#### ${a.label}\n  result=${a.sawResult}  (${a.why})  文本=${JSON.stringify(a.text)}\n  事件=${a.seq}\n`);

  const b = await run('B 启用端口兜底（修复后）', { SERVER__PORT: String(BUSY_PORT) });
  console.log(`#### ${b.label}\n  result=${b.sawResult}  (${b.why})  文本=${JSON.stringify(b.text)}\n  事件=${b.seq}\n`);

  blocker.close();
  process.exit(0);
})();
